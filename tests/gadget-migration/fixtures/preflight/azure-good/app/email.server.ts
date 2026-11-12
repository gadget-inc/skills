import nodemailer from "nodemailer";

// port 587 with STARTTLS; Container Apps can't send on port 25
export const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: 587,
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
});
