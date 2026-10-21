import type { ImApi } from "@tomradex/plugin-sdk";
import type { Facade } from "./shared.js";

export const imApi = ({ host }: Facade): ImApi => ({
  register: (spec) => host.call(() => {
    host.own(spec.id, "IM adapter");
    const open = host.back(spec.open, `IM adapter ${spec.id} open`);
    return host.disposerOf(host.svc("im").register({ ...spec, open: async (id, io) => {
      const session = await open(id, io);
      return {
        deliver: host.back(session.deliver.bind(session), `IM adapter ${spec.id} deliver`),
        ...(session.download ? { download: host.back(session.download.bind(session), `IM adapter ${spec.id} download`) } : {}),
        ...(session.indicate ? { indicate: host.back(session.indicate.bind(session), `IM adapter ${spec.id} indicate`) } : {}),
        ...(session.react ? { react: host.back(session.react.bind(session), `IM adapter ${spec.id} react`) } : {}),
        ...(session.commands ? { commands: host.back(session.commands.bind(session), `IM adapter ${spec.id} commands`) } : {}),
        ...(session.stream ? { stream: {
          start: host.back(session.stream.start.bind(session.stream), `IM adapter ${spec.id} stream start`),
          append: host.back(session.stream.append.bind(session.stream), `IM adapter ${spec.id} stream append`),
          stop: host.back(session.stream.stop.bind(session.stream), `IM adapter ${spec.id} stream stop`)
        } } : {}),
        ...(session.topics ? { topics: {
          open: host.back(session.topics.open.bind(session.topics), `IM adapter ${spec.id} topic open`),
          update: host.back(session.topics.update.bind(session.topics), `IM adapter ${spec.id} topic update`)
        } } : {}),
        ...(session.identity ? { identity: session.identity } : {}),
        ...(session.links ? { links: session.links } : {}),
        close: host.back(session.close.bind(session), `IM adapter ${spec.id} close`)
      };
    } }));
  })
});
