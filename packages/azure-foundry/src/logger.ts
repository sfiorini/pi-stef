const PREFIX = "[azure-foundry]";

export const log = {
  debug(message: string): void {
    if (process.env.PI_AZURE_FOUNDRY_DEBUG === "1") {
      console.debug(PREFIX, message);
    }
  },
  info(message: string): void {
    console.info(PREFIX, message);
  },
  warn(message: string): void {
    console.warn(PREFIX, message);
  },
  error(message: string): void {
    console.error(PREFIX, message);
  },
};
