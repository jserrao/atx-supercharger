import { env } from "cloudflare:workers";

const TESLA_PUBLIC_KEY = env.TESLA_PUBLIC_KEY;

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (
      url.pathname ===
      "/.well-known/appspecific/com.tesla.3p.public-key.pem"
    ) {
      return new Response(TESLA_PUBLIC_KEY, {
        headers: {
          "content-type": "application/x-pem-file",
        },
      });
    }

    return new Response("Tesla Fleet API probe is running.", {
      headers: {
        "content-type": "text/plain",
      },
    });
  },
};