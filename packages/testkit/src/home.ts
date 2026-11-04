/**
 * Makes `dir` the home folder the code under test sees, and returns how to put the person's back. Node reads HOME on
 * macOS and Linux but USERPROFILE on Windows, so a test that set HOME alone read and wrote the person's real home there.
 */
export function useHome(dir: string): () => void {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
