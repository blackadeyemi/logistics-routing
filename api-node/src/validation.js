const { z } = require('zod');
const { HttpError } = require('./errors');

function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    throw new HttpError(400, 'Validation failed', details);
  }
  return result.data;
}

// Accepts 0803 123 4567, 2348031234567, +234 803 123 4567 and returns
// the E.164 form +2348031234567. Returns null when it is not a Nigerian
// mobile number.
function normalizeNigerianPhone(input) {
  const digits = String(input).replace(/[\s\-().]/g, '');
  let national;
  if (/^\+234\d{10}$/.test(digits)) national = digits.slice(4);
  else if (/^234\d{10}$/.test(digits)) national = digits.slice(3);
  else if (/^0\d{10}$/.test(digits)) national = digits.slice(1);
  else return null;
  if (!/^[789]\d{9}$/.test(national)) return null;
  return `+234${national}`;
}

const phone = z.string().transform((v, ctx) => {
  const n = normalizeNigerianPhone(v);
  if (!n) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Not a valid Nigerian mobile number' });
    return z.NEVER;
  }
  return n;
});

const location = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  })
  .nullable();

const id = z.coerce.number().int().positive();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

function idParam(req) {
  return parse(id, req.params.id);
}

module.exports = { z, parse, phone, location, id, isoDate, idParam, normalizeNigerianPhone };
