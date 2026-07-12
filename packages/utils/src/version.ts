export const VERSION = '2.10.0';
export const BUILD_TIME = new Date().toISOString();

export function getVersionInfo(): string {
  return `v${VERSION} (built: ${BUILD_TIME})`;
}