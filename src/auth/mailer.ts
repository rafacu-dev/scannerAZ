import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.js";

let transporter: Transporter | undefined;

export class EmailUnavailableError extends Error {
  constructor() {
    super("Outgoing email is not configured");
  }
}

/** A configured provider that could not accept or deliver a message. */
export class EmailDeliveryError extends Error {
  readonly providerCode?: string;

  constructor(error: unknown) {
    super("Outgoing email could not be delivered");
    this.name = "EmailDeliveryError";
    this.providerCode = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "") || undefined
      : undefined;
  }
}

export function isEmailConfigured() {
  return Boolean(config.HOSTINGER_MAIL_API_KEY || (config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS));
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

export type EmailLocale = "es" | "en";

const brandName = "SellerAI";

// Sign-in email copy per app language; the app sends its current language.
const signInCopy: Record<EmailLocale, {
  subject: (code: string) => string;
  intro: string;
  textIntro: (code: string) => string;
  expiry: string;
}> = {
  es: {
    subject: (code) => `${code} es tu código de ${brandName}`,
    intro: "Tu código para entrar es:",
    textIntro: (code) => `Tu código para entrar en ${brandName} es: ${code}`,
    expiry: "Caduca en 10 minutos. Si no lo pediste, puedes ignorar este correo."
  },
  en: {
    subject: (code) => `${code} is your ${brandName} code`,
    intro: "Your sign-in code is:",
    textIntro: (code) => `Your ${brandName} sign-in code is: ${code}`,
    expiry: "It expires in 10 minutes. If you didn't request it, you can ignore this email."
  }
};

export function emailLocaleFrom(value: unknown): EmailLocale {
  return typeof value === "string" && value.trim().toLowerCase().startsWith("en") ? "en" : "es";
}

export async function sendSignInCodeEmail(to: string, code: string, locale: EmailLocale = "es") {
  const spacedCode = `${code.slice(0, 3)} ${code.slice(3)}`;
  const copy = signInCopy[locale];
  const message = {
    subject: copy.subject(spacedCode),
    text: [copy.textIntro(spacedCode), "", copy.expiry].join("\n"),
    html: `
      <div lang="${locale}" style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:420px;margin:0 auto;padding:32px 24px;color:#17202a">
        <div style="font-size:20px;font-weight:800;color:#146eb4">${brandName}</div>
        <p style="font-size:16px;margin:24px 0 8px">${copy.intro}</p>
        <div style="font-size:34px;font-weight:800;letter-spacing:6px;background:#eaf3fb;color:#0d4f86;border-radius:12px;padding:16px;text-align:center">${spacedCode}</div>
        <p style="font-size:14px;color:#687385;margin-top:20px">${copy.expiry}</p>
      </div>
    `
  };

  try {
    if (config.HOSTINGER_MAIL_API_KEY) {
      await sendWithHostingerMailApi(to, message);
      return;
    }

    await getTransporter().sendMail({
      from: { name: brandName, address: emailAddressFrom(config.EMAIL_FROM) },
      to,
      ...message
    });
  } catch (error) {
    throw new EmailDeliveryError(error);
  }
}

async function sendWithHostingerMailApi(
  to: string,
  message: { subject: string; text: string; html: string }
) {
  const headers = {
    authorization: `Bearer ${config.HOSTINGER_MAIL_API_KEY!}`,
    accept: "application/json"
  };
  const accountResponse = await fetch("https://api.mail.hostinger.com/api/v1/me", { headers });

  if (!accountResponse.ok) {
    throw { code: `HOSTINGER_ME_${accountResponse.status}` };
  }

  const account = await accountResponse.json() as { data?: { mailboxes?: Array<{ resourceId?: string; address?: string }> } };
  const fromAddress = emailAddressFrom(config.EMAIL_FROM);
  const mailbox = account.data?.mailboxes?.find((candidate) =>
    candidate.address?.trim().toLowerCase() === fromAddress
  );

  if (!mailbox?.resourceId) {
    throw { code: "HOSTINGER_MAILBOX_NOT_AUTHORIZED" };
  }

  const response = await fetch(
    `https://api.mail.hostinger.com/api/v1/mailboxes/${encodeURIComponent(mailbox.resourceId)}/send`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ to: [to], displayName: brandName, ...message })
    }
  );

  if (!response.ok) {
    throw { code: `HOSTINGER_SEND_${response.status}` };
  }
}

function emailAddressFrom(value: string) {
  const bracketed = /<([^>]+)>/.exec(value)?.[1];
  return (bracketed ?? value).trim().toLowerCase();
}
