/**
 * Tests for P8-001 Google Business Profile review model foundation:
 *   1. GmbLocation - tenant-scoped location records, provider dedup, sync state.
 *   2. Review - provider review dedup, rating/star validation, sentiment/status.
 *   3. ReviewReplyDraft - approval-first reply drafts with AI provenance.
 *   4. ApprovalRequest/AuditLog/model barrels - enum integration points.
 *
 * Model layer only. No Google API calls, Redis, routes, or workers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";

let mongoServer;
let GmbLocation;
let Review;
let ReviewReplyDraft;
let ApprovalRequest;
let AuditLog;

const oid = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  GmbLocation = (await import("../../src/models/GmbLocation.js")).default;
  Review = (await import("../../src/models/Review.js")).default;
  ReviewReplyDraft = (
    await import("../../src/models/ReviewReplyDraft.js")
  ).default;
  ApprovalRequest = (await import("../../src/models/ApprovalRequest.js")).default;
  AuditLog = (await import("../../src/models/AuditLog.js")).default;

  await GmbLocation.syncIndexes();
  await Review.syncIndexes();
  await ReviewReplyDraft.syncIndexes();
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, 15000);

beforeEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

function buildLocation(overrides = {}) {
  return {
    tenantId: overrides.tenantId || oid(),
    channelAccountId: overrides.channelAccountId || oid(),
    providerLocationId: overrides.providerLocationId || "locations/123",
    providerAccountId: overrides.providerAccountId || "accounts/abc",
    title: overrides.title || "Acme Main Street",
    ...overrides,
  };
}

function buildReview(overrides = {}) {
  return {
    tenantId: overrides.tenantId || oid(),
    channelAccountId: overrides.channelAccountId || oid(),
    gmbLocationId: overrides.gmbLocationId || oid(),
    providerReviewId: overrides.providerReviewId || "reviews/abc",
    starRating: overrides.starRating || "FIVE",
    rating: overrides.rating ?? 5,
    comment: overrides.comment || "Excellent service.",
    ...overrides,
  };
}

function buildReplyDraft(overrides = {}) {
  return {
    tenantId: overrides.tenantId || oid(),
    channelAccountId: overrides.channelAccountId || oid(),
    gmbLocationId: overrides.gmbLocationId || oid(),
    reviewId: overrides.reviewId || oid(),
    body: overrides.body || "Thank you for the kind review.",
    ...overrides,
  };
}

describe("GmbLocation - schema and tenant isolation", () => {
  it("creates a valid location with defaults", async () => {
    const location = await GmbLocation.create(buildLocation());

    expect(location.status).toBe("active");
    expect(location.verificationStatus).toBe("unknown");
    expect(location.consecutiveErrors).toBe(0);
    expect(location.deletedAt).toBeNull();
  });

  it("requires tenantId, channelAccountId, providerLocationId, and title", async () => {
    await expect(GmbLocation.create({})).rejects.toThrow();
  });

  it("enforces unique providerLocationId per tenant", async () => {
    const tenantId = oid();
    await GmbLocation.create(
      buildLocation({ tenantId, providerLocationId: "locations/dup" }),
    );

    await expect(
      GmbLocation.create(
        buildLocation({ tenantId, providerLocationId: "locations/dup" }),
      ),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("allows the same providerLocationId across tenants", async () => {
    const providerLocationId = "locations/shared";
    await GmbLocation.create(buildLocation({ tenantId: oid(), providerLocationId }));

    await expect(
      GmbLocation.create(buildLocation({ tenantId: oid(), providerLocationId })),
    ).resolves.toBeDefined();
  });

  it("validates status and verification enums", async () => {
    await expect(
      GmbLocation.create(buildLocation({ status: "unknown_status" })),
    ).rejects.toThrow();
    await expect(
      GmbLocation.create(
        buildLocation({ verificationStatus: "half_verified" }),
      ),
    ).rejects.toThrow();
  });

  it("validates latitude and longitude bounds", async () => {
    await expect(
      GmbLocation.create(
        buildLocation({ latLng: { latitude: 200, longitude: 75 } }),
      ),
    ).rejects.toThrow();
    await expect(
      GmbLocation.create(
        buildLocation({ latLng: { latitude: 12.9, longitude: -181 } }),
      ),
    ).rejects.toThrow();
  });

  it("stores address, categories, and sync state", async () => {
    const syncedAt = new Date();
    const location = await GmbLocation.create(
      buildLocation({
        address: {
          addressLines: ["100 Main Street"],
          locality: "Dallas",
          administrativeArea: "TX",
          postalCode: "75001",
          regionCode: "us",
          languageCode: "EN",
        },
        categories: ["Restaurant", "Cafe"],
        syncCursor: "cursor-1",
        lastSyncedAt: syncedAt,
      }),
    );

    expect(location.address.regionCode).toBe("US");
    expect(location.address.languageCode).toBe("en");
    expect(location.categories).toContain("Cafe");
    expect(location.lastSyncedAt.getTime()).toBe(syncedAt.getTime());
  });

  it("isolates location queries by tenantId", async () => {
    const tenantA = oid();
    const tenantB = oid();
    await GmbLocation.create(buildLocation({ tenantId: tenantA }));
    await GmbLocation.create(
      buildLocation({ tenantId: tenantB, providerLocationId: "locations/b" }),
    );

    expect(await GmbLocation.countDocuments({ tenantId: tenantA })).toBe(1);
    expect(await GmbLocation.countDocuments({ tenantId: tenantB })).toBe(1);
  });
});

describe("Review - schema, provider dedup, and reply links", () => {
  it("creates a valid review with defaults", async () => {
    const review = await Review.create(buildReview());

    expect(review.provider).toBe("gmb");
    expect(review.status).toBe("new");
    expect(review.sentiment).toBe("unknown");
    expect(review.providerReply.comment).toBeNull();
  });

  it("requires providerReviewId and star rating", async () => {
    await expect(
      Review.create({
        tenantId: oid(),
        channelAccountId: oid(),
        gmbLocationId: oid(),
      }),
    ).rejects.toThrow();
  });

  it("enforces unique providerReviewId per tenant/provider", async () => {
    const tenantId = oid();
    await Review.create(buildReview({ tenantId, providerReviewId: "reviews/dup" }));

    await expect(
      Review.create(buildReview({ tenantId, providerReviewId: "reviews/dup" })),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("allows the same providerReviewId across tenants", async () => {
    const providerReviewId = "reviews/shared";
    await Review.create(buildReview({ tenantId: oid(), providerReviewId }));

    await expect(
      Review.create(buildReview({ tenantId: oid(), providerReviewId })),
    ).resolves.toBeDefined();
  });

  it("derives numeric rating when omitted", async () => {
    const review = await Review.create(
      buildReview({ starRating: "THREE", rating: undefined }),
    );

    expect(review.rating).toBe(3);
  });

  it("rejects mismatched rating and starRating", async () => {
    await expect(
      Review.create(buildReview({ starRating: "ONE", rating: 5 })),
    ).rejects.toThrow(/does not match starRating/i);
  });

  it("validates provider, status, sentiment, and rating bounds", async () => {
    await expect(
      Review.create(buildReview({ provider: "yelp" })),
    ).rejects.toThrow();
    await expect(
      Review.create(buildReview({ status: "queued" })),
    ).rejects.toThrow();
    await expect(
      Review.create(buildReview({ sentiment: "furious" })),
    ).rejects.toThrow();
    await expect(
      Review.create(buildReview({ starRating: "FIVE", rating: 6 })),
    ).rejects.toThrow();
  });

  it("stores reviewer, provider reply, and approval/AI links", async () => {
    const aiRunId = oid();
    const approvalRequestId = oid();
    const replyDraftId = oid();
    const review = await Review.create(
      buildReview({
        reviewer: {
          displayName: "Alice",
          providerReviewerId: "people/123",
          isAnonymous: false,
        },
        providerReply: {
          comment: "Thanks, Alice.",
          updateTime: new Date(),
        },
        aiRunId,
        approvalRequestId,
        replyDraftId,
      }),
    );

    expect(review.reviewer.displayName).toBe("Alice");
    expect(review.providerReply.comment).toBe("Thanks, Alice.");
    expect(review.aiRunId.toString()).toBe(aiRunId.toString());
    expect(review.approvalRequestId.toString()).toBe(
      approvalRequestId.toString(),
    );
    expect(review.replyDraftId.toString()).toBe(replyDraftId.toString());
  });

  it("isolates reviews by tenantId and location", async () => {
    const tenantA = oid();
    const tenantB = oid();
    const locationA = oid();
    await Review.create(
      buildReview({ tenantId: tenantA, gmbLocationId: locationA }),
    );
    await Review.create(
      buildReview({
        tenantId: tenantB,
        providerReviewId: "reviews/b",
      }),
    );

    expect(await Review.countDocuments({ tenantId: tenantA })).toBe(1);
    expect(
      await Review.countDocuments({ tenantId: tenantA, gmbLocationId: locationA }),
    ).toBe(1);
  });
});

describe("ReviewReplyDraft - approval and AI provenance", () => {
  it("creates a human draft with approval required by default", async () => {
    const draft = await ReviewReplyDraft.create(buildReplyDraft());

    expect(draft.status).toBe("draft");
    expect(draft.source).toBe("human");
    expect(draft.requiresApproval).toBe(true);
    expect(draft.aiGenerated).toBe(false);
  });

  it("requires tenantId, reviewId, location/account ids, and body", async () => {
    await expect(ReviewReplyDraft.create({})).rejects.toThrow();
  });

  it("trims body and rejects empty replies", async () => {
    await expect(
      ReviewReplyDraft.create(buildReplyDraft({ body: "   " })),
    ).rejects.toThrow();
  });

  it("validates status, source, and confidence bounds", async () => {
    await expect(
      ReviewReplyDraft.create(buildReplyDraft({ status: "sent" })),
    ).rejects.toThrow();
    await expect(
      ReviewReplyDraft.create(buildReplyDraft({ source: "robot" })),
    ).rejects.toThrow();
    await expect(
      ReviewReplyDraft.create(buildReplyDraft({ confidence: 1.5 })),
    ).rejects.toThrow();
  });

  it("marks source=ai as aiGenerated and requires aiRunId", async () => {
    await expect(
      ReviewReplyDraft.create(buildReplyDraft({ source: "ai" })),
    ).rejects.toThrow(/AI-generated review replies require aiRunId/i);

    const aiRunId = oid();
    const draft = await ReviewReplyDraft.create(
      buildReplyDraft({ source: "ai", aiRunId, confidence: 0.84 }),
    );

    expect(draft.aiGenerated).toBe(true);
    expect(draft.aiRunId.toString()).toBe(aiRunId.toString());
  });

  it("requires aiRunId when aiGenerated is explicitly true", async () => {
    await expect(
      ReviewReplyDraft.create(buildReplyDraft({ aiGenerated: true })),
    ).rejects.toThrow(/AI-generated review replies require aiRunId/i);
  });

  it("dedupes per-tenant idempotencyKey", async () => {
    const tenantId = oid();
    await ReviewReplyDraft.create(
      buildReplyDraft({ tenantId, idempotencyKey: "gmb.reply:1" }),
    );

    await expect(
      ReviewReplyDraft.create(
        buildReplyDraft({ tenantId, idempotencyKey: "gmb.reply:1" }),
      ),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("allows the same idempotencyKey across tenants", async () => {
    await ReviewReplyDraft.create(
      buildReplyDraft({ tenantId: oid(), idempotencyKey: "shared" }),
    );

    await expect(
      ReviewReplyDraft.create(
        buildReplyDraft({ tenantId: oid(), idempotencyKey: "shared" }),
      ),
    ).resolves.toBeDefined();
  });

  it("stores approval, content draft, publish, and error metadata", async () => {
    const approvalRequestId = oid();
    const contentDraftId = oid();
    const publishedAt = new Date();
    const draft = await ReviewReplyDraft.create(
      buildReplyDraft({
        status: "published",
        approvalRequestId,
        contentDraftId,
        providerReplyId: "locations/1/reviews/2/reply",
        providerUpdateTime: publishedAt,
        publishedAt,
        error: { message: "previous transient", code: "rate_limit" },
        riskFlags: ["angry_customer"],
      }),
    );

    expect(draft.approvalRequestId.toString()).toBe(
      approvalRequestId.toString(),
    );
    expect(draft.providerReplyId).toContain("/reply");
    expect(draft.error.code).toBe("rate_limit");
    expect(draft.riskFlags).toContain("angry_customer");
    expect(draft.publishedAt.getTime()).toBe(publishedAt.getTime());
  });

  it("isolates reply drafts by tenantId", async () => {
    const tenantA = oid();
    await ReviewReplyDraft.create(buildReplyDraft({ tenantId: tenantA }));
    await ReviewReplyDraft.create(
      buildReplyDraft({ tenantId: oid(), reviewId: oid() }),
    );

    expect(await ReviewReplyDraft.countDocuments({ tenantId: tenantA })).toBe(1);
  });
});

describe("GMB model integration points", () => {
  it("ApprovalRequest accepts gmb.reply for review_reply", async () => {
    const tenantId = oid();
    const replyDraftId = oid();
    const approval = await ApprovalRequest.create({
      tenantId,
      type: "gmb.reply",
      relatedEntityType: "review_reply",
      relatedEntityId: replyDraftId,
      summary: "Approve public review reply",
      aiGenerated: true,
      aiRunId: oid(),
      confidence: 0.88,
    });

    expect(approval.type).toBe("gmb.reply");
    expect(approval.relatedEntityType).toBe("review_reply");
  });

  it("AuditLog accepts GMB entity types", async () => {
    const tenantId = oid();
    for (const entityType of ["gmb_location", "review", "review_reply"]) {
      const log = await AuditLog.create({
        tenantId,
        action: "gmb.synced",
        entityType,
        entityId: oid(),
        description: `audit for ${entityType}`,
      });
      expect(log.entityType).toBe(entityType);
    }
  });

  it("main models barrel exports GMB models and constants", async () => {
    const idx = await import("../../src/models/index.js");

    expect(idx.GmbLocation).toBeDefined();
    expect(idx.Review).toBeDefined();
    expect(idx.ReviewReplyDraft).toBeDefined();
    expect(idx.GMB_LOCATION_STATUSES).toContain("active");
    expect(idx.REVIEW_STAR_RATINGS).toContain("FIVE");
    expect(idx.REVIEW_REPLY_DRAFT_STATUSES).toContain("pending_approval");
  });
});
