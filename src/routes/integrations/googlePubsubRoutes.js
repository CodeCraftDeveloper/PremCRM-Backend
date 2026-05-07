import express from "express";
import { handleGmailPubsubPush } from "../../controllers/integrations/gmailPubsubController.js";

/**
 * Public Pub/Sub push routes.
 *
 * Mounted OUTSIDE the authenticated integration prefix because Google's
 * Pub/Sub service can't carry user credentials. The shared verification
 * token (and, when configured, an OIDC bearer JWT audience check) gates
 * access. CSRF is bypassed for this prefix in `middlewares/csrf.js`.
 */
const router = express.Router();

router.post("/gmail/push", handleGmailPubsubPush);

export default router;
