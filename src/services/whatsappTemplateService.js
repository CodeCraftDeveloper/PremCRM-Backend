/**
 * WhatsappTemplateService — tenant-scoped CRUD for Meta-approved
 * WhatsApp Business templates. P6-003.
 *
 * Templates are added by an admin (manually mirrored from Meta Business
 * Manager today; automated sync from the Graph API can be a follow-up).
 * Sending logic in `whatsappOutboundService` resolves an approved
 * template + language pair before composing a draft.
 */

import WhatsappTemplate from "../models/inbox/WhatsappTemplate.js";
import { ApiError } from "../utils/apiResponse.js";
import AuditLog from "../models/AuditLog.js";

function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
}

function normalizeLanguage(language) {
  return String(language || "").trim();
}

function normalizeComponentType(type) {
  return String(type || "").trim().toLowerCase();
}

function normalizeButtonType(type) {
  return String(type || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

function countPositionalParameters(text) {
  const matches = String(text || "").match(/\{\{\s*(\d+)\s*\}\}/g) || [];
  const indices = matches
    .map((m) => Number(m.replace(/[^\d]/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  return indices.length === 0 ? 0 : Math.max(...indices);
}

function getTemplateComponent(template, type) {
  return (template.components || []).find(
    (component) => String(component?.type || "").toUpperCase() === type,
  );
}

function sanitizeComponents(components) {
  if (!Array.isArray(components)) return [];
  return components
    .filter((c) => c && typeof c === "object")
    .map((c) => ({
      type: String(c.type || "").toUpperCase(),
      format: c.format ? String(c.format).toUpperCase() : null,
      text: typeof c.text === "string" ? c.text : null,
      example: c.example ?? null,
      buttons: Array.isArray(c.buttons) ? c.buttons : undefined,
    }));
}

async function upsertTemplate({
  tenantId,
  channelAccountId = null,
  name,
  language,
  category,
  status = "pending",
  components = [],
  metaTemplateId = null,
  statusReason = null,
  createdBy = null,
}) {
  if (!tenantId) throw ApiError.badRequest("tenantId is required");
  const cleanName = normalizeName(name);
  const cleanLang = normalizeLanguage(language);
  if (!cleanName) throw ApiError.badRequest("name is required");
  if (!cleanLang) throw ApiError.badRequest("language is required");
  if (!category) throw ApiError.badRequest("category is required");

  const sanitized = sanitizeComponents(components);
  const update = {
    tenantId,
    channelAccountId: channelAccountId || null,
    name: cleanName,
    language: cleanLang,
    category: String(category).toUpperCase(),
    status,
    components: sanitized,
    metaTemplateId: metaTemplateId || null,
    statusReason: statusReason || null,
    syncedAt: new Date(),
    deletedAt: null,
  };

  const existing = await WhatsappTemplate.findOne({
    tenantId,
    name: cleanName,
    language: cleanLang,
    deletedAt: null,
  });

  if (existing) {
    Object.assign(existing, update);
    await existing.save();
    AuditLog.record({
      tenantId,
      userId: createdBy || null,
      action: "whatsapp.template_updated",
      entityType: "whatsapp_template",
      entityId: existing._id,
      description: `WhatsApp template ${cleanName}/${cleanLang} updated`,
      metadata: { status, category: update.category },
    });
    return existing;
  }

  const created = await WhatsappTemplate.create({
    ...update,
    createdBy: createdBy || null,
  });
  AuditLog.record({
    tenantId,
    userId: createdBy || null,
    action: "whatsapp.template_created",
    entityType: "whatsapp_template",
    entityId: created._id,
    description: `WhatsApp template ${cleanName}/${cleanLang} registered`,
    metadata: { status, category: update.category },
  });
  return created;
}

async function listTemplates({
  tenantId,
  status = null,
  channelAccountId = null,
  search = null,
  page = 1,
  limit = 20,
}) {
  if (!tenantId) throw ApiError.badRequest("tenantId is required");
  const filter = { tenantId, deletedAt: null };
  if (status) filter.status = status;
  if (channelAccountId) filter.channelAccountId = channelAccountId;
  if (search) {
    filter.name = { $regex: String(search).trim().toLowerCase(), $options: "i" };
  }
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

  const [items, totalDocs] = await Promise.all([
    WhatsappTemplate.find(filter)
      .sort({ name: 1, language: 1 })
      .skip((pg - 1) * lim)
      .limit(lim)
      .lean(),
    WhatsappTemplate.countDocuments(filter),
  ]);

  return { items, page: pg, limit: lim, totalDocs };
}

async function getTemplateById({ tenantId, id }) {
  const tpl = await WhatsappTemplate.findOne({
    _id: id,
    tenantId,
    deletedAt: null,
  }).lean();
  if (!tpl) throw ApiError.notFound("WhatsApp template not found");
  return tpl;
}

async function findApprovedTemplate({ tenantId, name, language, channelAccountId = null }) {
  const cleanName = normalizeName(name);
  const cleanLang = normalizeLanguage(language);
  if (!cleanName || !cleanLang) {
    throw ApiError.badRequest("templateName and language are required");
  }
  const filter = {
    tenantId,
    name: cleanName,
    language: cleanLang,
    status: "approved",
    deletedAt: null,
  };
  // If a channelAccountId is supplied, accept either an account-scoped
  // approval for that account or a tenant-wide template (null binding).
  const template = channelAccountId
    ? await WhatsappTemplate.findOne({
        ...filter,
        $or: [{ channelAccountId }, { channelAccountId: null }],
      })
    : await WhatsappTemplate.findOne(filter);
  if (!template) {
    throw ApiError.badRequest(
      `WhatsApp template "${cleanName}" (${cleanLang}) is not approved for this tenant`,
    );
  }
  return template;
}

async function deleteTemplate({ tenantId, id, deletedBy = null }) {
  const tpl = await WhatsappTemplate.findOne({
    _id: id,
    tenantId,
    deletedAt: null,
  });
  if (!tpl) throw ApiError.notFound("WhatsApp template not found");
  tpl.deletedAt = new Date();
  await tpl.save();
  AuditLog.record({
    tenantId,
    userId: deletedBy || null,
    action: "whatsapp.template_deleted",
    entityType: "whatsapp_template",
    entityId: tpl._id,
    description: `WhatsApp template ${tpl.name}/${tpl.language} deleted`,
  });
  return { id: String(tpl._id), deleted: true };
}

function getUserComponents(components, type) {
  if (!Array.isArray(components)) return [];
  return components.filter((component) => normalizeComponentType(component?.type) === type);
}

function requireSingleComponent(components, type) {
  if (components.length > 1) {
    throw ApiError.badRequest(`Template ${type.toUpperCase()} component was provided more than once`);
  }
  return components[0] || null;
}

function textParameter(parameter) {
  const text = parameter?.text ?? parameter;
  return { type: "text", text: String(text ?? "") };
}

function hasTextParameter(parameter) {
  return parameter?.type === undefined || normalizeButtonType(parameter?.type) === "text";
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function mediaParameter(parameter, mediaType) {
  const normalizedMediaType = mediaType.toLowerCase();
  const media = parameter?.[normalizedMediaType];
  const directId = parameter?.id;
  const directLink = parameter?.link;
  const id = media?.id ?? directId;
  const link = media?.link ?? directLink;
  if (!hasValue(id) && !hasValue(link)) {
    throw ApiError.badRequest(
      `Template HEADER ${normalizedMediaType} parameter requires an id or link`,
    );
  }

  const output = { type: normalizedMediaType, [normalizedMediaType]: {} };
  if (hasValue(id)) output[normalizedMediaType].id = String(id);
  if (hasValue(link)) output[normalizedMediaType].link = String(link);
  if (normalizedMediaType === "document" && hasValue(media?.filename ?? parameter?.filename)) {
    output.document.filename = String(media?.filename ?? parameter?.filename);
  }
  return output;
}

function validateHeaderComponent({ template, userHeader }) {
  const headerSchema = getTemplateComponent(template, "HEADER");
  if (!headerSchema) {
    if (userHeader) {
      throw ApiError.badRequest(`Template "${template.name}" does not define a HEADER component`);
    }
    return null;
  }

  const format = String(headerSchema.format || "TEXT").toUpperCase();
  const expected =
    format === "TEXT" ? countPositionalParameters(headerSchema.text) : format ? 1 : 0;
  const provided = Array.isArray(userHeader?.parameters) ? userHeader.parameters : [];

  if (expected === 0) {
    if (provided.length > 0) {
      throw ApiError.badRequest(
        `Template "${template.name}" HEADER does not accept parameters; received ${provided.length}`,
      );
    }
    return null;
  }

  if (provided.length !== expected) {
    throw ApiError.badRequest(
      `Template "${template.name}" requires ${expected} HEADER parameter(s); received ${provided.length}`,
    );
  }

  if (format === "TEXT") {
    const parameter = provided[0];
    if (!hasTextParameter(parameter)) {
      throw ApiError.badRequest(`Template "${template.name}" HEADER parameter must be text`);
    }
    return { type: "header", parameters: [textParameter(parameter)] };
  }

  if (["IMAGE", "VIDEO", "DOCUMENT"].includes(format)) {
    return { type: "header", parameters: [mediaParameter(provided[0], format)] };
  }

  throw ApiError.badRequest(
    `Template "${template.name}" HEADER format ${format} is not supported for outbound validation`,
  );
}

function findButtonSchema(buttonsComponent, index) {
  const numericIndex = Number(index);
  if (!Number.isInteger(numericIndex) || numericIndex < 0) return null;
  const buttons = Array.isArray(buttonsComponent?.buttons) ? buttonsComponent.buttons : [];
  return buttons[numericIndex] || null;
}

function canonicalButtonSubType(buttonSchema) {
  const type = normalizeButtonType(buttonSchema?.type);
  if (type === "url") return "url";
  if (type === "quick_reply" || type === "quickreply") return "quick_reply";
  if (type === "copy_code" || type === "copycode") return "copy_code";
  return type;
}

function validateUrlButton({ template, index, buttonSchema, parameters }) {
  const expected = countPositionalParameters(buttonSchema?.url || buttonSchema?.text);
  if (parameters.length !== expected) {
    throw ApiError.badRequest(
      `Template "${template.name}" URL button ${index} requires ${expected} parameter(s); received ${parameters.length}`,
    );
  }
  if (expected === 0) return null;
  const parameter = parameters[0];
  if (!hasTextParameter(parameter)) {
    throw ApiError.badRequest(`Template "${template.name}" URL button ${index} parameter must be text`);
  }
  return {
    type: "button",
    sub_type: "url",
    index: String(index),
    parameters: [textParameter(parameter)],
  };
}

function validateQuickReplyButton({ template, index, parameters }) {
  if (parameters.length !== 1) {
    throw ApiError.badRequest(
      `Template "${template.name}" quick-reply button ${index} requires 1 payload parameter(s); received ${parameters.length}`,
    );
  }
  const parameter = parameters[0];
  if (normalizeButtonType(parameter?.type) !== "payload" || !hasValue(parameter?.payload)) {
    throw ApiError.badRequest(
      `Template "${template.name}" quick-reply button ${index} parameter must be payload`,
    );
  }
  return {
    type: "button",
    sub_type: "quick_reply",
    index: String(index),
    parameters: [{ type: "payload", payload: String(parameter.payload) }],
  };
}

function validateButtonComponents({ template, userButtons }) {
  const buttonsSchema = getTemplateComponent(template, "BUTTONS");
  if (!buttonsSchema) {
    if (userButtons.length > 0) {
      throw ApiError.badRequest(`Template "${template.name}" does not define BUTTON components`);
    }
    return [];
  }

  const out = [];
  const seen = new Set();
  for (const button of userButtons) {
    const index = button?.index;
    const indexKey = String(index);
    if (seen.has(indexKey)) {
      throw ApiError.badRequest(`Template "${template.name}" button ${indexKey} was provided more than once`);
    }
    seen.add(indexKey);

    const buttonSchema = findButtonSchema(buttonsSchema, index);
    if (!buttonSchema) {
      throw ApiError.badRequest(`Template "${template.name}" does not define button ${indexKey}`);
    }

    const subType = normalizeButtonType(button?.sub_type || button?.subType);
    const schemaSubType = canonicalButtonSubType(buttonSchema);
    if (subType !== schemaSubType) {
      throw ApiError.badRequest(
        `Template "${template.name}" button ${indexKey} must use sub_type ${schemaSubType}`,
      );
    }

    const parameters = Array.isArray(button?.parameters) ? button.parameters : [];
    if (schemaSubType === "url") {
      const validated = validateUrlButton({
        template,
        index: indexKey,
        buttonSchema,
        parameters,
      });
      if (validated) out.push(validated);
      continue;
    }

    if (schemaSubType === "quick_reply") {
      out.push(validateQuickReplyButton({ template, index: indexKey, parameters }));
      continue;
    }

    throw ApiError.badRequest(
      `Template "${template.name}" button ${indexKey} type ${schemaSubType} is not supported for outbound validation`,
    );
  }
  return out;
}

/**
 * Validate user-supplied components against a stored template.
 * Returns the canonical components array to send to Meta. Throws
 * ApiError.badRequest on mismatch.
 */
function buildSendComponents({ template, components = [] }) {
  const userBody = requireSingleComponent(getUserComponents(components, "body"), "body");
  const userHeader = requireSingleComponent(getUserComponents(components, "header"), "header");
  const userButtons = getUserComponents(components, "button");
  const expected = template.bodyParameterCount || 0;
  const provided = Array.isArray(userBody?.parameters) ? userBody.parameters : [];

  if (expected !== provided.length) {
    throw ApiError.badRequest(
      `Template "${template.name}" requires ${expected} body parameter(s); received ${provided.length}`,
    );
  }

  const out = [];
  if (expected > 0) {
    out.push({
      type: "body",
      parameters: provided.map((p) => ({
        type: "text",
        text: String(p?.text ?? p ?? ""),
      })),
    });
  }
  const header = validateHeaderComponent({ template, userHeader });
  if (header) out.push(header);
  out.push(...validateButtonComponents({ template, userButtons }));
  return out;
}

/**
 * Render a human-readable preview of a template body by substituting
 * positional parameters into the template body text. Used as the
 * Message.body snippet.
 */
function renderTemplatePreview({ template, components = [] }) {
  const body = (template.components || []).find((c) => c?.type === "BODY");
  let text = body?.text || `[template:${template.name}]`;
  const userBody = (Array.isArray(components) ? components : []).find(
    (c) => String(c?.type || "").toLowerCase() === "body",
  );
  const params = Array.isArray(userBody?.parameters) ? userBody.parameters : [];
  params.forEach((p, idx) => {
    const value = String(p?.text ?? p ?? "");
    text = text.replace(new RegExp(`\\{\\{\\s*${idx + 1}\\s*\\}\\}`, "g"), value);
  });
  return text;
}

export const WhatsappTemplateService = {
  upsertTemplate,
  listTemplates,
  getTemplateById,
  findApprovedTemplate,
  deleteTemplate,
  buildSendComponents,
  renderTemplatePreview,
};
