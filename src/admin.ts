import { timingSafeEqualString } from "./redact";

export async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  const expected = String(env.COLLECTOR_ADMIN_TOKEN ?? "").trim();
  if (!expected) {
    return Response.json({ error: "COLLECTOR_ADMIN_TOKEN is not configured" }, { status: 503 });
  }
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const provided = bearer || (request.headers.get("x-admin-token") ?? "").trim();
  if (!provided) {
    return Response.json(
      {
        error: "unauthorized",
        reason: "missing_token",
        hint: "Send Authorization: Bearer <token>. The token must be the Worker secret from `wrangler secret put COLLECTOR_ADMIN_TOKEN`, not an empty shell variable.",
      },
      { status: 401 },
    );
  }
  if (!(await timingSafeEqualString(provided, expected))) {
    return Response.json(
      {
        error: "unauthorized",
        reason: "token_mismatch",
        hint: "The Bearer token does not match the Worker secret. Re-run `npx wrangler secret put COLLECTOR_ADMIN_TOKEN` and use that same value in the header.",
      },
      { status: 401 },
    );
  }
  return null;
}
