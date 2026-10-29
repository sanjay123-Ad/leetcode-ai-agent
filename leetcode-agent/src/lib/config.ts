/**
 * Lazy, validated access to environment configuration.
 *
 * Nothing here reads `process.env` at module load time: a missing variable must
 * surface as an actionable error from the request that needs it, not as an
 * opaque import-time crash (audit finding C11).
 */

export class ConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, hint: string) {
    super(`Missing configuration: ${variable}. ${hint}`);
    this.name = 'ConfigError';
    this.variable = variable;
  }
}

function read(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function require_(name: string, hint: string): string {
  const value = read(name);
  if (!value) throw new ConfigError(name, hint);
  return value;
}

export const config = {
  geminiApiKey: () =>
    require_('GEMINI_API_KEY', 'Create a key at https://aistudio.google.com/apikey and add it to .env.local.'),

  /** Model used for every generation step. Overridable without touching code. */
  geminiModel: () => read('GEMINI_MODEL') ?? 'gemini-3.5-flash-lite',

  judge0ApiKey: () => read('JUDGE0_API_KEY'),
  judge0Host: () => read('JUDGE0_HOST') ?? 'judge0-ce.p.rapidapi.com',

  supabaseUrl: () => read('SUPABASE_URL') ?? read('NEXT_PUBLIC_SUPABASE_URL'),

  /**
   * Server-side key, in order of preference:
   *   1. SUPABASE_SECRET_KEY        — current convention (`sb_secret_…`)
   *   2. SUPABASE_SERVICE_ROLE_KEY  — legacy service-role JWT
   *
   * Both bypass RLS, so both must stay server-side. The publishable/anon key is
   * deliberately NOT a fallback here: `agent_runs` denies it by design, so falling back
   * would turn a configuration mistake into a silent permission error.
   */
  supabaseSecretKey: () => read('SUPABASE_SECRET_KEY') ?? read('SUPABASE_SERVICE_ROLE_KEY'),

  /** Publishable key. Only used for the legacy `problem_history` path. */
  supabasePublishableKey: () =>
    read('SUPABASE_PUBLISHABLE_KEY') ?? read('NEXT_PUBLIC_SUPABASE_ANON_KEY') ?? read('SUPABASE_ANON_KEY'),

  /** Whichever key is available, preferring the privileged one. */
  supabaseKey: () => config.supabaseSecretKey() ?? config.supabasePublishableKey(),

  /**
   * Bearer token required by the history endpoint. When it is unset the endpoint denies
   * every request: private solution history is never served unauthenticated.
   */
  historyApiToken: () => read('HISTORY_API_TOKEN'),

  cronSecret: () => read('CRON_SECRET'),

  /** Absolute base URL for server-to-server calls made by the cron route. */
  baseUrl: () =>
    read('NEXTAUTH_URL') ?? (read('VERCEL_URL') ? `https://${read('VERCEL_URL')}` : 'http://localhost:3000'),

  /** True on hosts with an ephemeral/read-only filesystem, where local history is pointless. */
  isServerless: () => Boolean(read('VERCEL') ?? read('AWS_LAMBDA_FUNCTION_NAME') ?? read('NETLIFY')),
};

/** Non-throwing readiness report, used by routes to fail fast with a clear message. */
export function configStatus() {
  return {
    gemini: Boolean(read('GEMINI_API_KEY')),
    judge0: Boolean(read('JUDGE0_API_KEY')),
    supabase: Boolean(config.supabaseUrl()) && Boolean(config.supabaseKey()),
    /** True when the privileged key is present, i.e. `agent_runs` is writable. */
    supabaseWritable: Boolean(config.supabaseUrl()) && Boolean(config.supabaseSecretKey()),
    historyAuth: Boolean(config.historyApiToken()),
    model: config.geminiModel(),
  };
}
