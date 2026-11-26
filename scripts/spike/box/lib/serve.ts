/**
 * Host side of a benchmark sandbox: a fake upstream and a provider proxy on a Unix socket, until killed.
 *   bun lib/serve.ts <llm.sock> <form A|B|C> <real credential> <placeholder>
 */
import { startFakeUpstream, startProviderProxy, type Form } from "./servers";

const [sock, form, real, placeholder] = process.argv.slice(2) as [string, Form, string, string];
const up = startFakeUpstream(form, real, placeholder);
startProviderProxy(sock, up.url, form, () => real);
console.log("ready", up.url);
setInterval(() => {}, 1 << 30);
