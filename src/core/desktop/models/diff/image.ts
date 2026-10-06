/**
 * A container for holding an image for display in the application
 */
export class Image {
  /**
   * @param contents The base64 encoded contents of the image.
   * @param mediaType The data URI media type, so the browser can render the image correctly.
   * @param bytes Size of the file in bytes.
   * @param src dsh-git 偏离(已登记在 `scripts/check-mirror.mjs` 的 EXPECTED):
   *            **可选的直链**。给定时 `ImageContainer` 直接用它,不再拼 data URL。
   *            上游只能走 `data:${mediaType};base64,${contents}`;而我们宿主用
   *            blob 端点 + HTTP 缓存给图片字节,重新 base64 一遍等于把同一份字节
   *            搬两次、还丢掉缓存语义。**缺省(不传)时行为与上游逐字一致**。
   */
  public constructor(
    public readonly rawContents: ArrayBufferLike,
    public readonly contents: string,
    public readonly mediaType: string,
    public readonly bytes: number,
    public readonly src?: string
  ) {}
}
