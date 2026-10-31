interface RendererFrame {
  url: string;
}

export function isTrustedRendererFrame(
  senderFrame: RendererFrame | null,
  mainFrame: RendererFrame | null,
  expectedUrl: string,
): boolean {
  return senderFrame !== null &&
    mainFrame !== null &&
    senderFrame === mainFrame &&
    senderFrame.url === expectedUrl &&
    expectedUrl.startsWith('file:///');
}
