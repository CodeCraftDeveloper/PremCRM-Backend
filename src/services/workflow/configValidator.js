/**
 * Tiny homemade config validator for action-registry entries.
 *
 * Each registry entry exposes a `configSchema = { fields: { <key>: <spec> } }`
 * spec; this module turns that into a validate(spec, value) that returns an
 * array of human-readable error messages (empty when valid).
 *
 * Supported field types:
 *   string         — `{ type: "string", minLength?, maxLength?, pattern?, required? }`
 *   number         — `{ type: "number", min?, max?, integer?, required? }`
 *   boolean        — `{ type: "boolean", required? }`
 *   objectIdString — Mongo ObjectId hex (24 chars). `{ type: "objectIdString", required? }`
 *   enum           — `{ type: "enum", values: [...], required? }`
 *   array          — `{ type: "array", of?: <spec>, minItems?, maxItems?, required? }`
 *   object         — `{ type: "object", fields?: { ... }, required? }`
 *
 * `additionalProperties` defaults to true (configs may carry extra keys for
 * UI/round-trip metadata). Set `strict: true` on the schema to reject extras.
 */

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

function pushFieldErrors(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function validateString(spec, value, path, errors) {
  if (typeof value !== "string") {
    return pushFieldErrors(errors, path, "must be a string");
  }
  if (typeof spec.minLength === "number" && value.length < spec.minLength) {
    pushFieldErrors(errors, path, `must be at least ${spec.minLength} chars`);
  }
  if (typeof spec.maxLength === "number" && value.length > spec.maxLength) {
    pushFieldErrors(errors, path, `must be at most ${spec.maxLength} chars`);
  }
  if (spec.pattern instanceof RegExp && !spec.pattern.test(value)) {
    pushFieldErrors(errors, path, "does not match required pattern");
  }
}

function validateNumber(spec, value, path, errors) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return pushFieldErrors(errors, path, "must be a finite number");
  }
  if (spec.integer && !Number.isInteger(value)) {
    pushFieldErrors(errors, path, "must be an integer");
  }
  if (typeof spec.min === "number" && value < spec.min) {
    pushFieldErrors(errors, path, `must be ≥ ${spec.min}`);
  }
  if (typeof spec.max === "number" && value > spec.max) {
    pushFieldErrors(errors, path, `must be ≤ ${spec.max}`);
  }
}

function validateBoolean(_spec, value, path, errors) {
  if (typeof value !== "boolean") {
    pushFieldErrors(errors, path, "must be a boolean");
  }
}

function validateObjectIdString(_spec, value, path, errors) {
  if (typeof value !== "string" || !OBJECT_ID_RE.test(value)) {
    pushFieldErrors(errors, path, "must be a 24-char hex ObjectId string");
  }
}

function validateEnum(spec, value, path, errors) {
  if (!Array.isArray(spec.values) || spec.values.length === 0) {
    return pushFieldErrors(errors, path, "schema is missing enum values");
  }
  if (!spec.values.includes(value)) {
    pushFieldErrors(
      errors,
      path,
      `must be one of: ${spec.values.map((v) => JSON.stringify(v)).join(", ")}`,
    );
  }
}

function validateArray(spec, value, path, errors) {
  if (!Array.isArray(value)) {
    return pushFieldErrors(errors, path, "must be an array");
  }
  if (typeof spec.minItems === "number" && value.length < spec.minItems) {
    pushFieldErrors(errors, path, `must have at least ${spec.minItems} items`);
  }
  if (typeof spec.maxItems === "number" && value.length > spec.maxItems) {
    pushFieldErrors(errors, path, `must have at most ${spec.maxItems} items`);
  }
  if (spec.of) {
    value.forEach((item, idx) => {
      validateField(spec.of, item, `${path}[${idx}]`, errors);
    });
  }
}

function validateObject(spec, value, path, errors) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return pushFieldErrors(errors, path, "must be an object");
  }
  if (spec.fields) {
    validateFields(spec.fields, value, path, errors, spec.strict === true);
  }
}

function validateField(spec, value, path, errors) {
  if (value === undefined || value === null) {
    if (spec.required) pushFieldErrors(errors, path, "is required");
    return;
  }
  switch (spec.type) {
    case "string":
      return validateString(spec, value, path, errors);
    case "number":
      return validateNumber(spec, value, path, errors);
    case "boolean":
      return validateBoolean(spec, value, path, errors);
    case "objectIdString":
      return validateObjectIdString(spec, value, path, errors);
    case "enum":
      return validateEnum(spec, value, path, errors);
    case "array":
      return validateArray(spec, value, path, errors);
    case "object":
      return validateObject(spec, value, path, errors);
    default:
      return pushFieldErrors(
        errors,
        path,
        `unknown schema type "${spec.type}"`,
      );
  }
}

function validateFields(fields, value, basePath, errors, strict) {
  for (const [key, spec] of Object.entries(fields)) {
    const path = basePath ? `${basePath}.${key}` : key;
    validateField(spec, value[key], path, errors);
  }
  if (strict) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) {
        const path = basePath ? `${basePath}.${key}` : key;
        pushFieldErrors(errors, path, "unknown field");
      }
    }
  }
}

/**
 * Validate a config object against a registry-entry config schema.
 * Returns an array of error messages; empty when valid.
 */
export function validateConfig(schema, value) {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;
  if (value === undefined || value === null) {
    // Top-level config may be missing entirely; treat each required field
    // as a separate error so the caller sees what's missing.
    return validateConfig(schema, {});
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    errors.push("config: must be an object");
    return errors;
  }
  if (schema.fields) {
    validateFields(schema.fields, value, "", errors, schema.strict === true);
  }
  return errors;
}

export const __TEST_ONLY__ = Object.freeze({
  OBJECT_ID_RE,
  validateField,
});
