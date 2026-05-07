// Unified Inbox domain models — single entry point
export {
  default as ChannelAccount,
  CHANNEL_PROVIDERS,
  CHANNEL_ACCOUNT_STATUSES,
} from "./ChannelAccount.js";

export {
  default as ContactIdentity,
  IDENTITY_PROVIDERS,
} from "./ContactIdentity.js";

export {
  default as Conversation,
  CONVERSATION_STATUSES,
  CONVERSATION_CHANNELS,
} from "./Conversation.js";

export {
  default as Message,
  MESSAGE_DIRECTIONS,
  MESSAGE_STATUSES,
  MESSAGE_CONTENT_TYPES,
} from "./Message.js";
