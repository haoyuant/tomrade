import { defineWords } from "@tomradex/domain";

/** A plugin or catalog download that did not get through, and the troubleshooter's row about it. */
export const COMMUNITY_WORDS = defineWords("community", {
  en: {
    unreachable: "could not reach {{host}}: {{cause}}. {{hint}}",
    causeName: "its name could not be resolved ({{code}})",
    causeTimeout: "the connection timed out ({{code}})",
    causeReset: "the connection was cut off ({{code}})",
    causeRefused: "the connection was refused ({{code}})",
    causeNoRoute: "there is no route to it ({{code}})",
    causeCertificate: "its certificate was not accepted ({{code}})",
    checkNetwork: "Check this machine's proxy or network.",
    socksSkipped: "The system proxy is SOCKS ({{proxy}}), which Tomrade cannot go through yet, so it connects directly: set an HTTP proxy in the system settings, or HTTPS_PROXY in the environment.",
    checkDownloads: "Plugin downloads",
    downloadsReached: "{{hosts}} reached",
    downloadsReachedDirect: "{{hosts}} reached directly. {{socks}}",
    downloadsRefused: "{{host}} answered {{status}}"
  },
  zh: {
    unreachable: "无法连接 {{host}}：{{cause}}。{{hint}}",
    causeName: "域名无法解析（{{code}}）",
    causeTimeout: "连接超时（{{code}}）",
    causeReset: "连接被中断（{{code}}）",
    causeRefused: "连接被拒绝（{{code}}）",
    causeNoRoute: "网络不通（{{code}}）",
    causeCertificate: "证书未被接受（{{code}}）",
    checkNetwork: "请检查这台电脑的代理或网络。",
    socksSkipped: "系统代理是 SOCKS（{{proxy}}），Tomrade 暂时无法通过它连接，所以会直接连网：请在系统设置里配置 HTTP 代理，或在环境变量里设置 HTTPS_PROXY。",
    checkDownloads: "插件下载",
    downloadsReached: "可以连接 {{hosts}}",
    downloadsReachedDirect: "直接连接 {{hosts}} 成功。{{socks}}",
    downloadsRefused: "{{host}} 返回了 {{status}}"
  }
});
