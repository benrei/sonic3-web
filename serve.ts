// Static dev server: bun run dev  (PORT=8333 by default)
import { resolve, normalize } from "path";

const root = import.meta.dir;
const port = Number(process.env.PORT ?? 8333);

Bun.serve({
  port,
  hostname: process.env.HOST ?? "127.0.0.1",
  async fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path.endsWith("/")) path += "index.html";
    const full = resolve(root, "." + normalize(path));
    if (!full.startsWith(root)) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(full);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    // always revalidate so deploys show up immediately (ETag/Last-Modified make this cheap)
    return new Response(file, { headers: { "Cache-Control": "no-cache" } });
  },
});
console.log(`Sonic 3 web: http://localhost:${port}/`);
