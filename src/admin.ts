import { timingSafeEqualString } from "./redact";

export async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  const expected = env.COLLECTOR_ADMIN_TOKEN;
  if (!expected) {
    return Response.json({ error: "COLLECTOR_ADMIN_TOKEN is not configured" }, { status: 503 });
  }
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const provided = bearer || (request.headers.get("x-admin-token") ?? "").trim();
  if (!provided || !(await timingSafeEqualString(provided, expected))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
