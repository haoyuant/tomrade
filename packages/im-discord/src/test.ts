import { FakeDiscord } from "./fake.js";

/**
 * `tomrade-plugin test` scenario: the adapter against a Discord made of fake
 * events, through the real IM layer and Agent. The runtime's fetch and
 * WebSocket stand in for Discord before the connection opens.
 */
export default async function scenario(t: {
  projectId: string;
  check(name: string, ok: boolean, detail?: string): void;
  im: {
    configure(settings: unknown): void;
    engine(engine: unknown): void;
    threads(): { id: string }[];
    thread(id: string): { runs: unknown[] };
    connections(): { state: string; identity?: { name?: string } }[];
  };
}) {
  const discord = new FakeDiscord();
  const net = discord.net();
  Object.assign(globalThis, { fetch: net.fetch, WebSocket: net.WebSocket });

  t.im.engine({ id: "fake", title: "Fake engine", author: "ai:test", available: async () => ({ ok: true }),
    async turn(input: { input: { kind: string; text?: string; value?: unknown } }, io: { emit(e: unknown): void; tools: { execute(n: string, a: unknown): Promise<unknown> } }) {
      if (input.input.kind === "answer") io.emit({ type: "text", text: `chose ${JSON.stringify(input.input.value)}` });
      else if (input.input.text === "pick") await io.tools.execute("ask_user", { question: "Ship it?", options: ["Yes", "No"] });
      else io.emit({ type: "text", text: `echo: ${input.input.text}` });
      return { stop: "end" };
    } });
  t.im.configure({ connections: [{ id: "discord", adapterId: "discord", credentials: { botToken: discord.token } }],
    routes: [{ id: "dm", connectionId: "discord", tenantId: "@me", conversationId: "20", projectId: t.projectId, engine: "fake", allowedActors: ["501"] }] });

  const until = async (what: string, condition: () => boolean, ms = 8000) => {
    for (let waited = 0; waited < ms; waited += 25) { if (condition()) return true; await new Promise(r => setTimeout(r, 25)); }
    t.check(what, false, "timed out");
    return false;
  };
  const posted = () => [...discord.messages.values()].filter(m => m.channel === "20").map(m => m.body);
  const said = (text: string) => posted().some(b => b.content === text);

  await until("connects", () => t.im.connections()[0]?.state === "connected");
  t.check("shows the bot it signed in as", t.im.connections()[0]?.identity?.name === "tomrade-bot");
  t.check("registers the /tomrade command", await until("registers the /tomrade command", () => discord.where("PUT", /\/commands$/).length === 1));

  discord.message({ channel: "20", author: "999", content: "outsider" });
  discord.message({ channel: "20", author: "501", content: "hello" });
  t.check("a direct message is answered", await until("a direct message is answered", () => said("echo: hello")));
  t.check("someone not allowed starts nothing", !said("echo: outsider"));

  discord.message({ channel: "20", author: "501", content: "pick" });
  await until("a question is asked", () => said("Ship it?"));
  const card = posted().find(b => b.content === "Ship it?") as { components: { components: { custom_id: string }[] }[] };
  const press = discord.interaction({ type: 3, channel: "20", user: "501", data: { custom_id: card.components[0]!.components[0]!.custom_id, component_type: 2 } });
  const pressed = Date.now();
  await until("the button is acknowledged", () => discord.where("POST", new RegExp(`^/interactions/${press.id}/`)).length === 1);
  t.check("a button is acknowledged within three seconds", discord.where("POST", new RegExp(`^/interactions/${press.id}/`))[0]!.at - pressed < 3000);
  t.check("a button answers the question", await until("a button answers the question", () => said('chose "Yes"')));

  const command = discord.interaction({ type: 2, channel: "20", user: "501", data: { name: "tomrade", options: [{ type: 1, name: "status" }] } });
  const commanded = Date.now();
  await until("the command is deferred", () => discord.where("POST", new RegExp(`^/interactions/${command.id}/`)).length === 1);
  t.check("a command is deferred within three seconds", discord.where("POST", new RegExp(`^/interactions/${command.id}/`))[0]!.at - commanded < 3000);
  t.check("/tomrade status answers", await until("/tomrade status answers", () => said("No task is running")));

  discord.drop();
  const missed = discord.message({ channel: "20", author: "501", content: "while away" });
  t.check("resumes and replays what it missed", await until("resumes and replays what it missed", () => said("echo: while away")));
  discord.dispatch("MESSAGE_CREATE", missed);
  await new Promise(r => setTimeout(r, 500));
  const runs = t.im.threads().reduce((n, th) => n + t.im.thread(th.id).runs.length, 0);
  t.check("a redelivered event runs once", runs === 4, `${runs} runs`);

  discord.failNext(c => c.method === "POST" && c.path === "/channels/20/messages", 429, { retryAfter: 0.2 });
  discord.message({ channel: "20", author: "501", content: "limited" });
  t.check("waits out a rate limit", await until("waits out a rate limit", () => said("echo: limited"), 12_000));
}
