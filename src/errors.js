export class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export function requireValue(ok, status, code) {
  if (!ok) throw new ApiError(status, code);
}
