import { env } from "cloudflare:workers";

function pemFromEnv(value) {
  if (!value) return "";
  return `${String(value).replace(/\\n/g, "\n").trim()}\n`;
}

const TESLA_PUBLIC_KEY = pemFromEnv(env.TESLA_PUBLIC_KEY);

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (
      url.pathname ===
      "/.well-known/appspecific/com.tesla.3p.public-key.pem"
    ) {
      const pem = TESLA_PUBLIC_KEY;
      if (!pem.includes("BEGIN PUBLIC KEY")) {
        return new Response("TESLA_PUBLIC_KEY is missing or invalid\n", {
          status: 500,
          headers: {
            "content-type": "text/plain; charset=utf-8",
          },
        });
      }

      return new Response(pem, {
        headers: {
          "content-type": "application/x-pem-file; charset=utf-8",
        },
      });
    }

    return new Response("Fleet API probe is running.", {
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  },
};