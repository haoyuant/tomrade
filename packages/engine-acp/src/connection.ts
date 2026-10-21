import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonLinePeer, jsonRpc } from "@tomradex/engine-kit";

/** ACP's error code for "sign in first". */
export const AUTH_REQUIRED = -32000;

/**
 * JSON-RPC 2.0 over newline-delimited stdio with one ACP agent process. A
 * request waits 60 s by default; a prompt passes 0 and runs until its turn ends.
 * A null result stays null.
 */
export const acpConnection = (child: ChildProcessWithoutNullStreams, name: string, locale?: string): JsonLinePeer =>
  new JsonLinePeer(child, { name, dialect: jsonRpc({ version: true }), locale });
