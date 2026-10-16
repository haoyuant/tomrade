import type {} from "cordis";

export { Repos, ReposConfig, CheckoutUnsetError, type CheckoutSelection, type CheckoutView, type FolderRepo, type MissingWorkdir, type WorkdirView } from "./service.js";
export { isLocalRemote, normalizeRemote, remoteIdentity, sameRepository, serverHost, sshHostName, type RemoteIdentity } from "./remotes.js";
export { Repos as default } from "./service.js";
