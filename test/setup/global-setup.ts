import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type {} from "vitest";
import type { TestProject } from "vitest/node";

const FIXTURES_DIR = path.join(process.cwd(), "test", "fixtures");

type FixtureMap = Record<string, string>;

function readFixtures(): FixtureMap {
  const map: FixtureMap = {};
  if (!fs.existsSync(FIXTURES_DIR)) return map;

  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith(".json")) {
        const name = `${prefix}${entry.name.slice(0, -5)}`;
        map[name] = fs.readFileSync(path.join(dir, entry.name), "utf8");
      }
    }
  };

  walk(FIXTURES_DIR, "");
  return map;
}

export default async function ({ provide }: TestProject) {
  const fixtures = readFixtures();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, `http://localhost`);
    if (req.method === "POST" && url.pathname.startsWith("/fixture/")) {
      const name = decodeURIComponent(url.pathname.slice("/fixture/".length));
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const parts = name.split("/");
        const fixturePath = path.join(FIXTURES_DIR, ...parts) + ".json";
        fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
        fs.writeFileSync(fixturePath, body);
        res.writeHead(200);
        res.end("ok");
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };

  provide("fixturePort", address.port);
  provide("fixtures", fixtures);
  provide("isRecording", process.env.RECORD === "1");

  return async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  };
}
