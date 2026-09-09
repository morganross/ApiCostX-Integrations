type SocketFailure = {
  code?: unknown;
  socket?: {
    remoteAddress?: unknown;
    remotePort?: unknown;
  };
};

export function isExpectedLangGraphTransportTermination(reason: unknown, deploymentUrl: string): boolean {
  if (!(reason instanceof TypeError) || reason.message !== "terminated") return false;

  const cause = reason.cause as SocketFailure | undefined;
  if (cause?.code !== "UND_ERR_SOCKET") return false;

  try {
    const target = new URL(deploymentUrl);
    const expectedPort = target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
    const remotePort = Number(cause.socket?.remotePort);
    if (!Number.isInteger(remotePort) || remotePort !== expectedPort) return false;

    const remoteAddress = String(cause.socket?.remoteAddress ?? "");
    const normalizedHost = target.hostname === "localhost" ? "127.0.0.1" : target.hostname;
    return remoteAddress === normalizedHost || (normalizedHost === "127.0.0.1" && remoteAddress === "::1");
  } catch {
    return false;
  }
}

export function summarizeUnhandledReason(reason: unknown): Record<string, string> {
  if (!(reason instanceof Error)) return { name: "NonErrorRejection", message: String(reason).slice(0, 500) };

  const cause = reason.cause as { code?: unknown } | undefined;
  const summary: Record<string, string> = {
    name: reason.name,
    message: reason.message.slice(0, 500)
  };
  if (typeof cause?.code === "string") summary.code = cause.code;
  return summary;
}
