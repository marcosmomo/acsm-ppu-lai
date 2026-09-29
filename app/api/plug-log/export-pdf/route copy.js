import fs from 'fs/promises';
import path from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const runtime = 'nodejs';

const LOG_FILE = path.join(process.cwd(), 'data', 'plug-phase-log.json');
const LOGO_FILE = path.join(process.cwd(), 'public', 'acsm-logo.png');

function safeText(value) {
  if (value === null || value === undefined) return '-';
  return String(value);
}

function formatDate(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString('pt-PT');
  } catch {
    return String(value);
  }
}

function wrapText(text, maxChars = 90) {
  const content = safeText(text);
  const words = content.split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (test.length > maxChars) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }

  if (current) lines.push(current);
  return lines;
}

function groupEventsByCps(events) {
  const groups = new Map();

  for (const evt of events) {
    const key = evt?.cpsName || evt?.cpsId || 'Unknown CPS';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(evt);
  }

  return Array.from(groups.entries()).map(([cpsName, items]) => ({
    cpsName,
    cpsId: items[0]?.cpsId || '-',
    topic: items[0]?.topic || '-',
    events: items,
  }));
}

export async function GET() {
  try {
    const raw = await fs.readFile(LOG_FILE, 'utf-8');

    let log;
    try {
      log = JSON.parse(raw);
    } catch (parseError) {
      return Response.json(
        {
          error: 'O arquivo plug-phase-log.json está com JSON inválido.',
          details: String(parseError?.message || parseError),
        },
        { status: 500 }
      );
    }

    const events = Array.isArray(log?.events) ? log.events : [];
    const grouped = groupEventsByCps(events);

    const pdfDoc = await PDFDocument.create();

    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    let logoImage = null;
    try {
      const logoBytes = await fs.readFile(LOGO_FILE);
      logoImage = await pdfDoc.embedPng(logoBytes);
    } catch {
      logoImage = null;
    }

    const PAGE_W = 595.28; // A4
    const PAGE_H = 841.89;
    const MARGIN = 40;

    const COLORS = {
      primary: rgb(0.0, 0.30, 0.60),
      secondary: rgb(0.12, 0.20, 0.30),
      accent: rgb(0.88, 0.93, 0.98),
      border: rgb(0.80, 0.85, 0.90),
      lightText: rgb(0.40, 0.45, 0.52),
      success: rgb(0.10, 0.50, 0.25),
      danger: rgb(0.75, 0.18, 0.18),
      black: rgb(0, 0, 0),
      white: rgb(1, 1, 1),
    };

    let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;

    const pages = [page];

    function addPage() {
      page = pdfDoc.addPage([PAGE_W, PAGE_H]);
      pages.push(page);
      y = PAGE_H - MARGIN;
    }

    function ensureSpace(heightNeeded = 80) {
      if (y - heightNeeded < MARGIN) addPage();
    }

    function drawText(text, x, yPos, options = {}) {
      const {
        size = 10,
        font = fontRegular,
        color = COLORS.black,
      } = options;

      page.drawText(text, {
        x,
        y: yPos,
        size,
        font,
        color,
      });
    }

    function drawWrappedBlock(label, value, x, width, size = 10, gapAfter = 8) {
      const full = `${label}${safeText(value)}`;
      const lines = wrapText(full, Math.max(30, Math.floor(width / 5.2)));
      for (const line of lines) {
        ensureSpace(size + 8);
        drawText(line, x, y, { size, font: fontRegular, color: COLORS.black });
        y -= size + 4;
      }
      y -= gapAfter;
    }

    function drawSectionTitle(title) {
      ensureSpace(32);
      page.drawRectangle({
        x: MARGIN,
        y: y - 8,
        width: PAGE_W - MARGIN * 2,
        height: 24,
        color: COLORS.accent,
      });
      drawText(title, MARGIN + 10, y, {
        size: 13,
        font: fontBold,
        color: COLORS.primary,
      });
      y -= 32;
    }

    function drawDivider() {
      ensureSpace(10);
      page.drawLine({
        start: { x: MARGIN, y },
        end: { x: PAGE_W - MARGIN, y },
        thickness: 1,
        color: COLORS.border,
      });
      y -= 12;
    }

    function drawTableHeader(columns) {
      ensureSpace(28);
      let currentX = MARGIN;
      const rowHeight = 22;

      page.drawRectangle({
        x: MARGIN,
        y: y - 4,
        width: PAGE_W - MARGIN * 2,
        height: rowHeight,
        color: COLORS.primary,
      });

      for (const col of columns) {
        drawText(col.label, currentX + 4, y + 2, {
          size: 9,
          font: fontBold,
          color: COLORS.white,
        });
        currentX += col.width;
      }

      y -= 28;
    }

    function drawEventRow(evt, index) {
      const columns = [
        { key: 'idx', width: 28 },
        { key: 'date', width: 110 },
        { key: 'type', width: 120 },
        { key: 'message', width: 190 },
        { key: 'topic', width: 67 },
      ];

      const values = {
        idx: String(index + 1),
        date: formatDate(evt?.isoDate || evt?.ts),
        type: safeText(evt?.eventType),
        message: safeText(evt?.message),
        topic: safeText(evt?.topic),
      };

      const wrapped = {
        idx: [values.idx],
        date: wrapText(values.date, 18),
        type: wrapText(values.type, 18),
        message: wrapText(values.message, 34),
        topic: wrapText(values.topic, 10),
      };

      const maxLines = Math.max(
        wrapped.idx.length,
        wrapped.date.length,
        wrapped.type.length,
        wrapped.message.length,
        wrapped.topic.length
      );

      const rowHeight = Math.max(22, maxLines * 12 + 10);
      ensureSpace(rowHeight + 8);

      page.drawRectangle({
        x: MARGIN,
        y: y - 4,
        width: PAGE_W - MARGIN * 2,
        height: rowHeight,
        borderColor: COLORS.border,
        borderWidth: 1,
        color: index % 2 === 0 ? rgb(0.985, 0.99, 1) : COLORS.white,
      });

      let currentX = MARGIN;

      for (const col of columns) {
        const lines = wrapped[col.key];
        let localY = y + rowHeight - 16;

        for (const line of lines) {
          drawText(line, currentX + 4, localY, {
            size: 8.5,
            font: fontRegular,
            color: COLORS.secondary,
          });
          localY -= 11;
        }

        currentX += col.width;
      }

      y -= rowHeight + 6;
    }

    function addPageFooter(pageRef, pageNumber, totalPages) {
      const footerY = 20;
      pageRef.drawLine({
        start: { x: MARGIN, y: footerY + 12 },
        end: { x: PAGE_W - MARGIN, y: footerY + 12 },
        thickness: 1,
        color: COLORS.border,
      });

      pageRef.drawText('ACSM Lifecycle Management Report', {
        x: MARGIN,
        y: footerY,
        size: 8,
        font: fontRegular,
        color: COLORS.lightText,
      });

      pageRef.drawText(`Page ${pageNumber} of ${totalPages}`, {
        x: PAGE_W - MARGIN - 70,
        y: footerY,
        size: 8,
        font: fontRegular,
        color: COLORS.lightText,
      });
    }

    // CAPA
    page.drawRectangle({
      x: 0,
      y: 0,
      width: PAGE_W,
      height: PAGE_H,
      color: rgb(0.985, 0.99, 1),
    });

    page.drawRectangle({
      x: 0,
      y: PAGE_H - 130,
      width: PAGE_W,
      height: 130,
      color: COLORS.primary,
    });

    if (logoImage) {
      const scaledWidth = 110;
      const scaledHeight = (logoImage.height / logoImage.width) * scaledWidth;
      page.drawImage(logoImage, {
        x: MARGIN,
        y: PAGE_H - 105,
        width: scaledWidth,
        height: scaledHeight,
      });
    }

    page.drawText('ACSM', {
      x: MARGIN,
      y: PAGE_H - 180,
      size: 26,
      font: fontBold,
      color: COLORS.primary,
    });

    page.drawText('Plug Phase Lifecycle Report', {
      x: MARGIN,
      y: PAGE_H - 220,
      size: 22,
      font: fontBold,
      color: COLORS.secondary,
    });

    page.drawText('Industrial-style human-readable report for lifecycle evidence', {
      x: MARGIN,
      y: PAGE_H - 245,
      size: 11,
      font: fontRegular,
      color: COLORS.lightText,
    });

    page.drawRectangle({
      x: MARGIN,
      y: PAGE_H - 360,
      width: PAGE_W - MARGIN * 2,
      height: 100,
      color: COLORS.white,
      borderColor: COLORS.border,
      borderWidth: 1,
    });

    page.drawText('Experiment summary', {
      x: MARGIN + 14,
      y: PAGE_H - 285,
      size: 13,
      font: fontBold,
      color: COLORS.primary,
    });

    page.drawText(`Generated at: ${safeText(log?.generatedAt)}`, {
      x: MARGIN + 14,
      y: PAGE_H - 310,
      size: 10,
      font: fontRegular,
      color: COLORS.secondary,
    });

    page.drawText(`Total lifecycle events: ${events.length}`, {
      x: MARGIN + 14,
      y: PAGE_H - 330,
      size: 10,
      font: fontRegular,
      color: COLORS.secondary,
    });

    page.drawText(`Total CPS involved: ${grouped.length}`, {
      x: MARGIN + 14,
      y: PAGE_H - 350,
      size: 10,
      font: fontRegular,
      color: COLORS.secondary,
    });

    page.drawText('Prepared automatically from the Plug Phase event registry.', {
      x: MARGIN,
      y: 70,
      size: 10,
      font: fontRegular,
      color: COLORS.lightText,
    });

    // NOVA PÁGINA PARA CONTEÚDO
    addPage();

    // RESUMO EXECUTIVO
    drawSectionTitle('1. Executive Summary');
    drawWrappedBlock('Architecture: ', 'ACSM - Architecture of Control for Smart Manufacturing', MARGIN, 500);
    drawWrappedBlock('Phase: ', 'Plug Phase', MARGIN, 500);
    drawWrappedBlock('Objective: ', 'Provide a human-readable record of lifecycle evidence, onboarding history, and CPS-related operational transitions.', MARGIN, 500);
    drawWrappedBlock('Generated at: ', log?.generatedAt, MARGIN, 500);
    drawDivider();

    // VISÃO GERAL DOS CPS
    drawSectionTitle('2. CPS Overview');
    for (const group of grouped) {
      ensureSpace(54);
      page.drawRectangle({
        x: MARGIN,
        y: y - 6,
        width: PAGE_W - MARGIN * 2,
        height: 44,
        color: rgb(0.97, 0.98, 1),
        borderColor: COLORS.border,
        borderWidth: 1,
      });

      drawText(group.cpsName, MARGIN + 10, y + 14, {
        size: 11,
        font: fontBold,
        color: COLORS.primary,
      });

      drawText(`CPS ID: ${group.cpsId}   |   Topic: ${group.topic}   |   Events: ${group.events.length}`, MARGIN + 10, y - 2, {
        size: 9,
        font: fontRegular,
        color: COLORS.secondary,
      });

      y -= 56;
    }

    drawDivider();

    // EVENTOS POR CPS
    let cpsSectionIndex = 3;
    for (const group of grouped) {
      drawSectionTitle(`${cpsSectionIndex}. ${group.cpsName}`);
      drawWrappedBlock('CPS ID: ', group.cpsId, MARGIN, 500, 10, 4);
      drawWrappedBlock('MQTT Topic: ', group.topic, MARGIN, 500, 10, 10);

      drawTableHeader([
        { label: '#', width: 28 },
        { label: 'Date', width: 110 },
        { label: 'Event Type', width: 120 },
        { label: 'Message', width: 190 },
        { label: 'Topic', width: 67 },
      ]);

      group.events.forEach((evt, index) => {
        drawEventRow(evt, index);
      });

      y -= 8;
      drawDivider();
      cpsSectionIndex += 1;
    }

    // PAGINAÇÃO
    const totalPages = pages.length;
    pages.forEach((p, i) => addPageFooter(p, i + 1, totalPages));

    const pdfBytes = await pdfDoc.save();

    const fileName = `acsm-plug-phase-report-${new Date()
      .toISOString()
      .replace(/[:.]/g, '-')}.pdf`;

    return new Response(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return Response.json(
      {
        error: 'Failed to generate PDF log.',
        details: String(error?.message || error),
      },
      { status: 500 }
    );
  }
}