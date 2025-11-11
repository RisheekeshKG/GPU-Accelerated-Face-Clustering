export async function compressLikeBrowser(
  file: File,
  maxDim = 1440,
  quality = 0.9
): Promise<File> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = URL.createObjectURL(file);
  });

  const canvas = document.createElement("canvas");
  const scale = Math.min(maxDim / Math.max(img.width, img.height), 1);
  canvas.width = img.width * scale;
  canvas.height = img.height * scale;

  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  return new Promise<File>((resolve) => {
    canvas.toBlob(
      (blob) => {
        resolve(
          new File([blob!], file.name.replace(/\.\w+$/, ".jpg"), {
            type: "image/jpeg",
          })
        );
      },
      "image/jpeg",
      quality
    );
  });
}
