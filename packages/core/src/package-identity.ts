export const CORE_PACKAGE_NAME = "@marcoscale98/pi-extensible-workflows";
export const CORE_PACKAGE_COMPATIBILITY_NAME = "pi-extensible-workflows";
export const CORE_PACKAGE_NAMES = [CORE_PACKAGE_NAME, CORE_PACKAGE_COMPATIBILITY_NAME] as const;

export function isCorePackageName(value: unknown): boolean {
  return typeof value === "string" && CORE_PACKAGE_NAMES.includes(value as (typeof CORE_PACKAGE_NAMES)[number]);
}
