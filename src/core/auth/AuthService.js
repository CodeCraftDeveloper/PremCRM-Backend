import bcrypt from "bcryptjs";
import crypto from "crypto";
import User from "../../models/User.js";
import Invite from "../../models/Invite.js";
import Tenant from "../../models/Tenant.js";
import SessionService from "./SessionService.js";
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} from "../../utils/jwt.js";
import redis from "../../config/redis.js";
import logger from "../../utils/logger.js";
import { sendPasswordResetNotification } from "../../utils/passwordResetNotifier.js";

const HASH_ALGORITHM = "sha256";
const PLATFORM_TENANT_SLUG = "__platform__";

/**
 * AuthService
 * Secure authentication with HttpOnly cookies and invite-based registration
 */
class AuthService {
  static async resolveTenantCompanyBranding(company = {}, tenantId = null) {
    const resolved = { ...(company || {}) };
    // If logoS3Key is missing but logoUrl points to our S3 bucket, extract the key
    if (!resolved.logoS3Key && resolved.logoUrl) {
      const bucket = process.env.AWS_S3_BUCKET;
      if (bucket) {
        const pattern = new RegExp(
          `^https?://${bucket}\\.s3[.-][^/]+\\.amazonaws\\.com/(.+?)(?:\\?.*)?$`,
        );
        const match = resolved.logoUrl.match(pattern);
        if (match) {
          resolved.logoS3Key = match[1];
          // Backfill in DB (fire-and-forget)
          if (tenantId) {
            Tenant.updateOne(
              { _id: tenantId },
              { $set: { "company.logoS3Key": match[1] } },
            ).catch(() => {});
          }
        }
      }
    }
    return resolved;
  }

  /**
   * Ensure a legacy user has tenantId before creating session/token context.
   * Auto-fixes only when there is exactly one active tenant in the system.
   */
  static async ensureUserTenant(user) {
    if (user.tenantId) return user;

    const activeTenants = await Tenant.find(
      { isActive: true, slug: { $ne: PLATFORM_TENANT_SLUG } },
      { _id: 1 },
    )
      .limit(2)
      .lean();

    if (activeTenants.length === 1) {
      user.tenantId = activeTenants[0]._id;
      await user.save({ validateBeforeSave: false });
      logger.warn(
        `Backfilled missing tenantId for user ${user.email} to tenant ${activeTenants[0]._id}`,
      );
      return user;
    }

    throw new Error(
      "Cannot create session: tenantId is missing for user and cannot be auto-resolved",
    );
  }

  /**
   * Login user securely
   * @param {String} email - User email
   * @param {String} password - User password
   * @param {Object} metadata - Login metadata (IP, device, etc.)
   * @returns {Object} User and tokens
   */
  static async login(email, password, metadata = {}) {
    const normalizedEmail = String(email || "")
      .trim()
      .toLowerCase();
    try {
      const tenantSlug = String(metadata?.tenantSlug || "")
        .trim()
        .toLowerCase();
      const tenantIdFromMetadata = metadata.tenantId || null;

      let tenant = null;
      if (tenantSlug) {
        tenant = await Tenant.findOne({
          slug: tenantSlug,
          isActive: true,
        }).lean();
        if (!tenant) {
          throw new Error("Tenant not found or inactive");
        }
      } else if (tenantIdFromMetadata) {
        tenant = await Tenant.findOne({
          _id: tenantIdFromMetadata,
          isActive: true,
        }).lean();
        if (!tenant) {
          throw new Error("Tenant not found or inactive");
        }
      }

      // Find user with password field
      let userQuery = { email: normalizedEmail };
      if (tenant?._id) {
        userQuery = { ...userQuery, tenantId: tenant._id };
      }
      let user = await User.findOne(userQuery).select("+password");

      if (!user && !tenant) {
        const candidates = await User.find({ email: normalizedEmail })
          .select("+password")
          .sort({ createdAt: -1 })
          .limit(2);

        if (candidates.length > 1) {
          throw new Error(
            "Multiple workspaces found for this email. Please provide tenant slug.",
          );
        }
        user = candidates[0] || null;
      }

      if (!user) {
        throw new Error("Invalid credentials");
      }

      // Check if user is active
      if (!user.isActive) {
        // Give specific message for pending approval vs deactivated
        if (user.approvalStatus === "pending") {
          throw new Error(
            "Your account is pending admin approval. Please wait for approval.",
          );
        }
        if (user.approvalStatus === "rejected") {
          throw new Error(
            "Your registration has been rejected. Please contact the administrator.",
          );
        }
        throw new Error("Account has been deactivated");
      }

      // Check brute force protection BEFORE password comparison
      const attempts = await this.checkBruteForce(normalizedEmail);
      if (attempts >= 5) {
        throw new Error("Too many failed attempts. Try again later.");
      }

      // Verify password
      const isValidPassword = await bcrypt.compare(password, user.password);
      if (!isValidPassword) {
        throw new Error("Invalid credentials");
      }

      // Legacy data guard: ensure tenant context exists before session creation.
      user = await this.ensureUserTenant(user);

      const userTenant =
        tenant ||
        (await Tenant.findById(user.tenantId)
          .select("_id isActive slug name company")
          .lean());
      if (!userTenant || !userTenant.isActive) {
        throw new Error("Tenant is inactive");
      }

      if (tenant?._id && String(user.tenantId) !== String(tenant._id)) {
        throw new Error("Invalid credentials");
      }

      // Create session
      const session = await SessionService.createSession(user._id, {
        ...metadata,
        tenantId: user.tenantId,
      });

      // Generate tokens
      const tokens = this.generateTokens(user, session._id);

      // Update user — store hashed refresh token
      user.refreshToken = this.hashToken(tokens.refreshToken);
      user.lastLogin = new Date();
      await user.save({ validateBeforeSave: false });

      // Clear brute force counter
      try {
        await redis.del(`login:attempts:${user.email}`);
      } catch (redisError) {
        logger.warn(
          `Failed to clear login attempts for ${user.email}: ${redisError.message}`,
        );
      }

      logger.info(`User logged in: ${user.email}`);
      const tenantCompany = await this.resolveTenantCompanyBranding(
        userTenant.company || {},
        user.tenantId,
      );

      return {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          tenantId: user.tenantId,
          tenantSlug: userTenant.slug || null,
          tenantName: userTenant.name || null,
          tenantCompany,
        },
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      };
    } catch (error) {
      // Track failed attempt for brute force protection
      if (normalizedEmail) {
        try {
          await redis.incr(`login:attempts:${normalizedEmail}`);
          await redis.expire(`login:attempts:${normalizedEmail}`, 15 * 60); // 15 min window
        } catch (redisError) {
          logger.warn(
            `Failed to update login attempts for ${normalizedEmail}: ${redisError.message}`,
          );
        }
      }

      logger.warn(
        `Login failed for ${normalizedEmail || email}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Check failed login attempts
   * @param {String} email - User email
   * @returns {Number} Number of failed attempts
   */
  static async checkBruteForce(email) {
    try {
      const attempts = await redis.get(`login:attempts:${email}`);
      return parseInt(attempts || 0, 10);
    } catch (redisError) {
      logger.warn(
        `Failed to read login attempts for ${email}: ${redisError.message}`,
      );
      return 0;
    }
  }

  /**
   * Logout user
   * @param {String} userId - User ID
   * @param {String} tenantId - Tenant ID (REQUIRED)
   */
  static async logout(userId, tenantId) {
    if (!tenantId) throw new Error("tenantId is required");
    try {
      const sessions = await SessionService.getUserActiveSessions(
        userId,
        tenantId,
      );
      for (const session of sessions) {
        await SessionService.endSession(session._id, tenantId);
      }

      // P0-1: Scope user update by tenantId
      await User.findOneAndUpdate(
        { _id: userId, tenantId },
        { refreshToken: null },
      );

      logger.info(`User logged out: ${userId}`);
    } catch (error) {
      logger.error(`Error during logout: ${error.message}`);
      throw error;
    }
  }

  /**
   * Refresh access token
   * @param {String} refreshToken - Refresh token from cookie
   * @returns {Object} New tokens
   */
  static async refreshAccessToken(refreshToken) {
    try {
      if (!refreshToken) {
        throw new Error("Refresh token required");
      }

      // Verify token
      const decoded = verifyRefreshToken(refreshToken);
      const user = await User.findById(decoded.id).select("+refreshToken");

      if (!user || user.refreshToken !== this.hashToken(refreshToken)) {
        throw new Error("Invalid refresh token");
      }

      if (!user.isActive) {
        throw new Error("User account is deactivated");
      }

      const tenant = await Tenant.findById(user.tenantId)
        .select("isActive")
        .lean();
      if (!tenant || !tenant.isActive) {
        throw new Error("Tenant is inactive");
      }

      // Generate new tokens
      // P0-1: Pass tenantId to getUserActiveSessions for cross-tenant isolation
      const sessions = await SessionService.getUserActiveSessions(
        user._id,
        user.tenantId,
      );
      const tokens = this.generateTokens(user, sessions[0]?._id);

      user.refreshToken = this.hashToken(tokens.refreshToken);
      await user.save({ validateBeforeSave: false });

      logger.info(`Token refreshed for user: ${user._id}`);

      return tokens;
    } catch (error) {
      logger.error(`Error refreshing token: ${error.message}`);
      throw error;
    }
  }

  /**
   * Initiate password reset
   * Email-based, token sent via separate channel (NOT in logs)
   * @param {String} email - User email
   */
  static async initiatePasswordReset(email) {
    try {
      const user = await User.findOne({ email });

      // Return success even if user doesn't exist (security)
      if (!user) {
        logger.info(
          `Password reset requested for non-existent email: ${email}`,
        );
        return;
      }

      // Generate reset token (never stored plaintext)
      const resetToken = crypto.randomBytes(32).toString("hex");
      const resetTokenHash = this.hashToken(resetToken);

      user.passwordResetToken = resetTokenHash;
      user.passwordResetExpires = new Date(Date.now() + 30 * 60 * 1000); // 30 min
      await user.save({ validateBeforeSave: false });

      // Log ONLY hash prefix + expiry (never plaintext token)
      logger.info(
        `Password reset initiated for ${email}, token hash: ${resetTokenHash.substring(0, 8)}..., expires: ${user.passwordResetExpires.toISOString()}`,
      );

      try {
        await sendPasswordResetNotification({
          email,
          resetToken,
          tenantId: user.tenantId,
          userId: user._id,
        });
      } catch (notifyError) {
        logger.error(
          `Password reset notification failed for ${email}: ${notifyError.message}`,
        );
      }

      // Do NOT return the raw token — it must be delivered via email only
      return { message: "Password reset initiated" };
    } catch (error) {
      logger.error(`Error initiating password reset: ${error.message}`);
      throw error;
    }
  }

  /**
   * Reset password
   * @param {String} resetToken - Reset token from email
   * @param {String} newPassword - New password
   */
  static async resetPassword(resetToken, newPassword) {
    try {
      const resetTokenHash = this.hashToken(resetToken);

      const user = await User.findOne({
        passwordResetToken: resetTokenHash,
        passwordResetExpires: { $gt: new Date() },
      });

      if (!user) {
        throw new Error("Invalid or expired reset token");
      }

      // Update password
      user.password = newPassword;
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;
      user.refreshToken = null; // Force re-login
      await user.save();

      // Force logout all sessions (security)
      await SessionService.forceLogoutAllSessions(user._id, user.tenantId);

      logger.info(`Password reset completed for user: ${user._id}`);
      return user;
    } catch (error) {
      logger.error(`Error resetting password: ${error.message}`);
      throw error;
    }
  }

  /**
   * Change password for an authenticated user
   * @param {String} userId
   * @param {String} tenantId - Tenant ID (REQUIRED)
   * @param {String} currentPassword
   * @param {String} newPassword
   */
  static async changePassword(userId, tenantId, currentPassword, newPassword) {
    if (!tenantId) throw new Error("tenantId is required");
    try {
      const user = await User.findOne({ _id: userId, tenantId }).select(
        "+password",
      );
      if (!user) {
        throw new Error("User not found");
      }

      const isValidPassword = await bcrypt.compare(
        currentPassword,
        user.password,
      );
      if (!isValidPassword) {
        throw new Error("Current password is incorrect");
      }

      user.password = newPassword;
      user.refreshToken = null;
      await user.save();

      await SessionService.forceLogoutAllSessions(user._id, user.tenantId);
      logger.info(`Password changed for user: ${user._id}`);
    } catch (error) {
      logger.error(`Error changing password: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create invite (admin-only)
   * @param {String} email - Invitee email
   * @param {String} role - Role for invitee
   * @param {String} invitedByUserId - Admin creating invite
   * @param {String} tenantId - Tenant ID
   * @returns {Object} Invite with token
   */
  static async createInvite(email, role, invitedByUserId, tenantId) {
    try {
      // Check if user already exists
      const existingUser = await User.findOne({
        email,
        tenantId,
      });
      if (existingUser) {
        throw new Error("User already exists with this email");
      }

      // Generate invite token
      const inviteToken = crypto.randomBytes(32).toString("hex");
      const inviteTokenHash = this.hashToken(inviteToken);

      const invite = await Invite.create({
        email,
        role,
        tenantId,
        token: inviteTokenHash,
        status: "pending",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
        createdBy: invitedByUserId,
      });

      logger.info(`Invite created for ${email} with role ${role}`);

      return {
        invite: invite._id,
        token: inviteToken, // Return plaintext for email
      };
    } catch (error) {
      logger.error(`Error creating invite: ${error.message}`);
      throw error;
    }
  }

  /**
   * Accept invite (register via invite)
   * @param {String} inviteToken - Invite token from email
   * @param {String} password - User password
   * @param {String} userName - User name
   * @returns {Object} User and tokens
   */
  static async acceptInvite(inviteToken, password, userName) {
    try {
      const inviteTokenHash = this.hashToken(inviteToken);

      const invite = await Invite.findOne({
        token: inviteTokenHash,
        status: "pending",
        expiresAt: { $gt: new Date() },
      });

      if (!invite) {
        throw new Error("Invalid or expired invite");
      }

      const tenant = await Tenant.findById(invite.tenantId)
        .select("_id isActive settings.maxUsers activeUsers slug name company")
        .lean();

      if (!tenant || !tenant.isActive) {
        throw new Error("Tenant not found or inactive");
      }

      const existingUser = await User.findOne({
        tenantId: invite.tenantId,
        email: invite.email,
      }).lean();
      if (existingUser) {
        throw new Error(
          "User already exists with this email in this workspace",
        );
      }

      if (
        Number.isFinite(tenant?.settings?.maxUsers) &&
        tenant.activeUsers >= tenant.settings.maxUsers
      ) {
        throw new Error("Workspace user limit reached");
      }

      // Create user with role from invite
      const user = await User.create({
        name: userName,
        email: invite.email,
        password,
        role: invite.role,
        tenantId: invite.tenantId,
        isActive: true,
      });

      // Mark invite as accepted
      invite.status = "accepted";
      invite.acceptedAt = new Date();
      invite.acceptedBy = user._id;
      await invite.save();
      await Tenant.findByIdAndUpdate(invite.tenantId, {
        $inc: { activeUsers: 1 },
      });

      // Create session & login
      const session = await SessionService.createSession(user._id, {
        tenantId: user.tenantId,
      });

      const tokens = this.generateTokens(user, session._id);

      user.refreshToken = this.hashToken(tokens.refreshToken);
      await user.save({ validateBeforeSave: false });

      logger.info(`Invite accepted by ${user.email}`);
      const tenantCompany = await this.resolveTenantCompanyBranding(
        tenant.company || {},
        user.tenantId,
      );

      return {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          tenantId: user.tenantId,
          tenantSlug: tenant.slug || null,
          tenantName: tenant.name || null,
          tenantCompany,
        },
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      };
    } catch (error) {
      logger.error(`Error accepting invite: ${error.message}`);
      throw error;
    }
  }

  /**
   * Generate access + refresh tokens
   * @param {Object} user - User document
   * @param {String} sessionId - Session ID
   * @returns {Object} {accessToken, refreshToken}
   */
  static generateTokens(user, sessionId) {
    const accessToken = generateAccessToken({
      id: user._id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      sessionId,
    });

    const refreshToken = generateRefreshToken({
      id: user._id,
      tenantId: user.tenantId,
    });

    return { accessToken, refreshToken };
  }

  /**
   * Hash token for secure storage
   * @param {String} token - Token to hash
   * @returns {String} Hashed token
   */
  static hashToken(token) {
    return crypto.createHash(HASH_ALGORITHM).update(token).digest("hex");
  }
}

export default AuthService;
