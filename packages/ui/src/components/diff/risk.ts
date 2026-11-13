import type { MessageKey } from "~/lib/i18n";

const DEPENDENCIES = /(^|\/)(package\.json|(pnpm-lock|package-lock|npm-shrinkwrap)\.(yaml|json)|(yarn|bun|Cargo|Gemfile|composer|poetry|uv|Pipfile)\.lock|go\.(mod|sum)|Cargo\.toml|Gemfile|requirements[^/]*\.txt|pyproject\.toml)$/;

/**
 * What a changed file's path says a reviewer should not skim: a migration, the dependencies, who may do what, how it
 * ships. Read from the path alone, so the same file always gets the same label; it says nothing of what the change does.
 */
export function riskOf(file: string): MessageKey | null {
  if (/(^|\/)migrations?\//i.test(file) || /\.sql$/i.test(file) || /(^|\/)schema\.[a-z]+$/i.test(file)) return "diff.riskMigration";
  if (DEPENDENCIES.test(file)) return "diff.riskDependencies";
  if (/(^|\/)(auth|authz|permissions?|security|acl)(\/|\.[a-z]+$)/i.test(file)) return "diff.riskAccess";
  if (/(^|\/)(\.github\/workflows|deploy|infra|terraform|k8s)\//.test(file) || /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/.test(file)) return "diff.riskDeploy";
  return null;
}
