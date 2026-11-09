import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { NotifyClient } from "./notify.js";
import { Service } from "./service.js";
import { createServer } from "./server.js";

const cfg = loadConfig();
const db = new Db(cfg.dataDir);
const svc = new Service(cfg, db, new NotifyClient(cfg, db));
const server = createServer(cfg, svc);

server.listen(cfg.port, () => {
  const mode = cfg.notify.baseUrl ? `Notify ${cfg.notify.baseUrl}` : "notifications en mode console";
  console.log(`${cfg.brand.name} prêt sur ${cfg.publicBaseUrl} (port ${cfg.port}, ${mode})`);
});
