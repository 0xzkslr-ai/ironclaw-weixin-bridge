import QRCode from "qrcode";

export async function renderTerminalQr(text) {
  if (!text) return null;
  return QRCode.toString(text, {
    type: "terminal",
    small: true,
    errorCorrectionLevel: "M",
  });
}
