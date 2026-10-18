import { Router, type Response } from 'express';
import PDFDocument from 'pdfkit';
import type { Certificate, CertificateService } from '../services/certificate.service';

/**
 * pdfkit's built-in fonts only cover Latin-1. Names in other scripts get the HTML certificate
 * (any script renders in a browser) instead of a PDF with missing glyphs.
 */
export function pdfSupported(cert: Pick<Certificate, 'learnerName' | 'courseTitle'>): boolean {
  return /^[\u0020-\u007e\u00a0-\u00ff]*$/.test(`${cert.learnerName}${cert.courseTitle}`);
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const dateOf = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

const NOTE = 'This certificate records completion of the course. It is not an accreditation or assessment of mastery.';

function sendPdf(res: Response, cert: Certificate): void {
  res.status(200).type('application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="ekatra-certificate-${cert.code}.pdf"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 50 });
  doc.pipe(res);
  const w = doc.page.width;
  doc.rect(30, 30, w - 60, doc.page.height - 60).lineWidth(3).stroke('#25D366');
  doc.font('Helvetica-Bold').fontSize(34).fillColor('#1B5E20').text('Certificate of Completion', 0, 110, { align: 'center' });
  doc.font('Helvetica').fontSize(15).fillColor('#444').text('This certifies that', 0, 190, { align: 'center' });
  doc.font('Helvetica-Bold').fontSize(30).fillColor('#000').text(cert.learnerName, 60, 220, { align: 'center', width: w - 120 });
  doc.font('Helvetica').fontSize(15).fillColor('#444').text('has completed the course', 0, 275, { align: 'center' });
  doc.font('Helvetica-Bold').fontSize(24).fillColor('#000').text(cert.courseTitle, 60, 305, { align: 'center', width: w - 120 });
  doc.font('Helvetica').fontSize(12).fillColor('#444').text(`Issued ${dateOf(cert.issuedAt)}  ·  Certificate ID ${cert.code}`, 0, 400, { align: 'center' });
  doc.fontSize(9).fillColor('#777').text(`Ekatra  ·  ${NOTE}`, 60, 440, { align: 'center', width: w - 120 });
  doc.end();
}

function sendHtml(res: Response, cert: Certificate): void {
  res.status(200).type('html');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Certificate – ${esc(cert.courseTitle)}</title>
<style>body{font-family:Georgia,serif;background:#f5f5f5;margin:0;padding:24px}
.c{max-width:760px;margin:0 auto;background:#fff;border:6px double #25D366;padding:48px 32px;text-align:center}
h1{color:#1B5E20;margin:0 0 24px}.n{font-size:32px;font-weight:bold;margin:8px 0}.t{font-size:24px;font-weight:bold;margin:8px 0}
.m{color:#555;font-size:13px;margin-top:28px}.s{color:#777;font-size:11px;margin-top:16px}</style></head><body><div class="c">
<h1>Certificate of Completion</h1><div>This certifies that</div><div class="n">${esc(cert.learnerName)}</div>
<div>has completed the course</div><div class="t">${esc(cert.courseTitle)}</div>
<div class="m">Issued ${esc(dateOf(cert.issuedAt))} · Certificate ID ${esc(cert.code)}</div>
<div class="s">${esc(NOTE)}</div></div></body></html>`);
}

/** Public certificate pages. Access requires the signed, unguessable code from the learner's message. */
export function createCertificatesRouter(certs: CertificateService): Router {
  const router = Router();
  router.get('/:file', async (req, res) => {
    const file = String(req.params['file'] ?? '');
    const isPdf = file.toLowerCase().endsWith('.pdf');
    const cert = await certs.getByCode(isPdf ? file.slice(0, -4) : file);
    if (!cert) {
      res.status(404).type('text/plain').send('Certificate not found');
      return;
    }
    if (isPdf && pdfSupported(cert)) sendPdf(res, cert);
    else sendHtml(res, cert);
  });
  return router;
}
