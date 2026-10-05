import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.js";

let transporter: Transporter | undefined;

export class EmailUnavailableError extends Error {
  constructor() {
    super("Outgoing email is not configured");
  }
}

export function isEmailConfigured() {
  return Boolean(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS);
}

function getTransporter() {
  if (!isEmailConfigured()) {
    throw new EmailUnavailableError();
  }

  transporter ??= nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE ?? config.SMTP_PORT === 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS }
  });

  return transporter;
}

export async function sendSignInCodeEmail(to: string, code: string) {
  const spacedCode = `${code.slice(0, 3)} ${code.slice(3)}`;

  await getTransporter().sendMail({
    from: config.EMAIL_FROM,
    to,
    subject: `${spacedCode} es tu código de ScannerAz`,
    text: [
      `Tu código para entrar en ScannerAz es: ${spacedCode}`,
      "",
      "Caduca en 10 minutos. Si no lo pediste, puedes ignorar este correo."
    ].join("\n"),
    html: `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:420px;margin:0 auto;padding:32px 24px;color:#17202a">
        <div style="font-size:20px;font-weight:800;color:#146eb4">ScannerAz</div>
        <p style="font-size:16px;margin:24px 0 8px">Tu código para entrar es:</p>
        <div style="font-size:34px;font-weight:800;letter-spacing:6px;background:#eaf3fb;color:#0d4f86;border-radius:12px;padding:16px;text-align:center">${spacedCode}</div>
        <p style="font-size:14px;color:#687385;margin-top:20px">Caduca en 10 minutos. Si no lo pediste, puedes ignorar este correo.</p>
      </div>
    `
  });
}
