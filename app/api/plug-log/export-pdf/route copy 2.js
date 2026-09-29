import fs from 'fs/promises';
import path from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const runtime = 'nodejs';

const LOG_FILE = path.join(process.cwd(), 'data', 'plug-phase-log.json');
const ACSM_LOGO_FILE = path.join(process.cwd(), 'public', 'acsm-logo.png');
const UFSC_LOGO_FILE = path.join(process.cwd(), 'public', 'ufsc-logo.png');
const NOVA_LOGO_FILE = path.join(process.cwd(), 'public', 'nova-fct-logo.png');

const REPORT_CONFIG = {
  institutionLine1: 'Universidade Federal de Santa Catarina (UFSC)',
  institutionLine2: 'NOVA School of Science and Technology (NOVA FCT)',
  architectureName: 'ACSM - Architecture of Control for Smart Manufacturing',
  reportTitle: 'Plug, Play & Unplug Phase Lifecycle Industrial Report',
  reportSubtitle:
    'Human-readable academic and technical report for lifecycle evidence of cyber-physical systems',
  experimentName: 'Lifecycle Management Experiment - Plug Phase',
  prototypeVersion: 'Prototype Version: v1.0',
  reportLanguage: 'English',
};

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

function classifyEvent(eventType) {
  const type = String(eventType || '').toLowerCase();

  if (type.includes('registered')) {
    return {
      label: 'Registration',
      color: rgb(0.10, 0.45, 0.85),
      bg: rgb(0.92, 0.96, 1),
    };
  }

  if (type.includes('play') || type.includes('moved_to_play')) {
    return {
      label: 'Play Transition',
      color: rgb(0.08, 0.55, 0.28),
      bg: rgb(0.92, 0.98, 0.94),
    };
  }

  if (type.includes('unplug')) {
    return {
      label: 'Unplug',
      color: rgb(0.78, 0.17, 0.17),
      bg: rgb(0.99, 0.93, 0.93),
    };
  }

  if (type.includes('maintenance')) {
    return {
      label: 'Maintenance',
      color: rgb(0.82, 0.53, 0.10),
      bg: rgb(1, 0.97, 0.90),
    };
  }

  return {
    label: 'Lifecycle Event',
    color: rgb(0.35, 0.42, 0.52),
    bg: rgb(0.96, 0.97, 0.98),
  };
}

function summarizeEvents(events) {
  const summary = {
    registration: 0,
    play: 0,
    unplug: 0,
    maintenance: 0,
    other: 0,
  };

  for (const evt of events) {
    const type = String(evt?.eventType || '').toLowerCase();

    if (type.includes('registered')) summary.registration += 1;
    else if (type.includes('play') || type.includes('moved_to_play')) summary.play += 1;
    else if (type.includes('unplug')) summary.unplug += 1;
    else if (type.includes('maintenance')) summary.maintenance += 1;
    else summary.other += 1;
  }

  return summary;
}

function computeEventPeriod(events) {
  if (!events.length) {
    return {
      start: '-',
      end: '-',
    };
  }

  const timestamps = events
    .map((evt) => evt?.ts || evt?.isoDate)
    .filter(Boolean)
    .map((v) => new Date(v).getTime())
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);

  if (!timestamps.length) {
    return {
      start: '-',
      end: '-',
    };
  }

  return {
    start: formatDate(timestamps[0]),
    end: formatDate(timestamps[timestamps.length - 1]),
  };
}

async function tryEmbedPng(pdfDoc, filePath) {
  try {
    const bytes = await fs.readFile(filePath);
    return await pdfDoc.embedPng(bytes);
  } catch {
    return null;
  }
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
    const counters = summarizeEvents(events);
    const period = computeEventPeriod(events);

    const pdfDoc = await PDFDocument.create();
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const acsmLogo = await tryEmbedPng(pdfDoc, ACSM_LOGO_FILE);
    const ufscLogo = await tryEmbedPng(pdfDoc, UFSC_LOGO_FILE);
    const novaLogo = await tryEmbedPng(pdfDoc, NOVA_LOGO_FILE);

    const PAGE_W = 595.28;
    const PAGE_H = 841.89;
    const MARGIN = 40;

    const COLORS = {
      primary: rgb(0.0, 0.30, 0.60),
      secondary: rgb(0.13, 0.18, 0.25),
      accent: rgb(0.93, 0.96, 1),
      border: rgb(0.82, 0.86, 0.91),
      lightText: rgb(0.42, 0.47, 0.55),
      white: rgb(1, 1, 1),
      black: rgb(0, 0, 0),
      softBlue: rgb(0.97, 0.985, 1),
    };

    let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    const pages = [page];
    let y = PAGE_H - MARGIN;

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

    function drawSectionTitle(title) {
      ensureSpace(34);
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

    function drawWrappedParagraph(label, value, width = 500) {
      const lines = wrapText(`${label}${safeText(value)}`, Math.max(30, Math.floor(width / 5.2)));
      for (const line of lines) {
        ensureSpace(16);
        drawText(line, MARGIN, y, {
          size: 10,
          font: fontRegular,
          color: COLORS.secondary,
        });
        y -= 14;
      }
      y -= 6;
    }

    function drawKpiCard(x, yTop, width, height, label, value, color = COLORS.primary) {
      page.drawRectangle({
        x,
        y: yTop - height,
        width,
        height,
        color: COLORS.white,
        borderColor: COLORS.border,
        borderWidth: 1,
      });

      drawText(label, x + 10, yTop - 18, {
        size: 9,
        font: fontRegular,
        color: COLORS.lightText,
      });

      drawText(String(value), x + 10, yTop - 42, {
        size: 18,
        font: fontBold,
        color,
      });
    }

    function drawTableHeader() {
      ensureSpace(28);

      const columns = [
        { label: '#', width: 24 },
        { label: 'Date', width: 96 },
        { label: 'Class', width: 74 },
        { label: 'Event Type', width: 108 },
        { label: 'Message', width: 190 },
        { label: 'Topic', width: 23 },
      ];

      page.drawRectangle({
        x: MARGIN,
        y: y - 4,
        width: PAGE_W - MARGIN * 2,
        height: 22,
        color: COLORS.primary,
      });

      let currentX = MARGIN;
      for (const col of columns) {
        drawText(col.label, currentX + 4, y + 2, {
          size: 8.5,
          font: fontBold,
          color: COLORS.white,
        });
        currentX += col.width;
      }

      y -= 28;
    }

    function drawEventRow(evt, index) {
      const classification = classifyEvent(evt?.eventType);

      const columns = [
        { key: 'idx', width: 24 },
        { key: 'date', width: 96 },
        { key: 'class', width: 74 },
        { key: 'type', width: 108 },
        { key: 'message', width: 190 },
        { key: 'topic', width: 23 },
      ];

      const values = {
        idx: String(index + 1),
        date: formatDate(evt?.isoDate || evt?.ts),
        class: classification.label,
        type: safeText(evt?.eventType),
        message: safeText(evt?.message),
        topic: safeText(evt?.topic),
      };

      const wrapped = {
        idx: [values.idx],
        date: wrapText(values.date, 16),
        class: wrapText(values.class, 11),
        type: wrapText(values.type, 18),
        message: wrapText(values.message, 34),
        topic: wrapText(values.topic, 7),
      };

      const maxLines = Math.max(
        wrapped.idx.length,
        wrapped.date.length,
        wrapped.class.length,
        wrapped.type.length,
        wrapped.message.length,
        wrapped.topic.length
      );

      const rowHeight = Math.max(24, maxLines * 12 + 10);
      ensureSpace(rowHeight + 8);

      page.drawRectangle({
        x: MARGIN,
        y: y - 4,
        width: PAGE_W - MARGIN * 2,
        height: rowHeight,
        color: index % 2 === 0 ? COLORS.softBlue : COLORS.white,
        borderColor: COLORS.border,
        borderWidth: 1,
      });

      page.drawRectangle({
        x: MARGIN,
        y: y - 4,
        width: 4,
        height: rowHeight,
        color: classification.color,
      });

      let currentX = MARGIN;

      for (const col of columns) {
        const lines = wrapped[col.key];
        let localY = y + rowHeight - 16;

        for (const line of lines) {
          drawText(line, currentX + 4, localY, {
            size: 8.2,
            font: fontRegular,
            color: col.key === 'class' ? classification.color : COLORS.secondary,
          });
          localY -= 11;
        }

        currentX += col.width;
      }

      y -= rowHeight + 6;
    }

    function drawCpsHeader(group, sectionIndex) {
      ensureSpace(72);

      page.drawRectangle({
        x: MARGIN,
        y: y - 10,
        width: PAGE_W - MARGIN * 2,
        height: 52,
        color: rgb(0.97, 0.985, 1),
        borderColor: COLORS.border,
        borderWidth: 1,
      });

      drawText(`${sectionIndex}. ${safeText(group.cpsName)}`, MARGIN + 10, y + 14, {
        size: 12,
        font: fontBold,
        color: COLORS.primary,
      });

      drawText(
        `CPS ID: ${safeText(group.cpsId)}   |   MQTT Topic: ${safeText(group.topic)}   |   Total Events: ${group.events.length}`,
        MARGIN + 10,
        y - 4,
        {
          size: 9,
          font: fontRegular,
          color: COLORS.secondary,
        }
      );

      y -= 64;
    }

    function addFooter(pageRef, pageNumber, totalPages) {
      const footerY = 20;

      pageRef.drawLine({
        start: { x: MARGIN, y: footerY + 12 },
        end: { x: PAGE_W - MARGIN, y: footerY + 12 },
        thickness: 1,
        color: COLORS.border,
      });

      pageRef.drawText('UFSC + NOVA FCT + ACSM - Plug Phase Lifecycle Report', {
        x: MARGIN,
        y: footerY,
        size: 8,
        font: fontRegular,
        color: COLORS.lightText,
      });

      pageRef.drawText(`Page ${pageNumber} / ${totalPages}`, {
        x: PAGE_W - MARGIN - 52,
        y: footerY,
        size: 8,
        font: fontRegular,
        color: COLORS.lightText,
      });
    }

    function drawImageIfExists(image, x, yPos, width) {
      if (!image) return;
      const height = (image.height / image.width) * width;
      page.drawImage(image, { x, y: yPos, width, height });
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
      y: PAGE_H - 120,
      width: PAGE_W,
      height: 120,
      color: COLORS.primary,
    });

    drawImageIfExists(ufscLogo, 40, PAGE_H - 92, 70);
    drawImageIfExists(acsmLogo, 245, PAGE_H - 100, 95);
    drawImageIfExists(novaLogo, 465, PAGE_H - 92, 70);

    page.drawText(REPORT_CONFIG.institutionLine1, {
      x: MARGIN,
      y: PAGE_H - 155,
      size: 11,
      font: fontRegular,
      color: COLORS.secondary,
    });

    page.drawText(REPORT_CONFIG.institutionLine2, {
      x: MARGIN,
      y: PAGE_H - 172,
      size: 11,
      font: fontRegular,
      color: COLORS.secondary,
    });

    page.drawText(REPORT_CONFIG.architectureName, {
      x: MARGIN,
      y: PAGE_H - 205,
      size: 12,
      font: fontBold,
      color: COLORS.primary,
    });

    page.drawText(REPORT_CONFIG.reportTitle, {
      x: MARGIN,
      y: PAGE_H - 238,
      size: 22,
      font: fontBold,
      color: COLORS.secondary,
    });

    page.drawText(REPORT_CONFIG.reportSubtitle, {
      x: MARGIN,
      y: PAGE_H - 260,
      size: 10.5,
      font: fontRegular,
      color: COLORS.lightText,
    });

    page.drawRectangle({
      x: MARGIN,
      y: PAGE_H - 390,
      width: PAGE_W - MARGIN * 2,
      height: 135,
      color: COLORS.white,
      borderColor: COLORS.border,
      borderWidth: 1,
    });

    page.drawText('Experiment cover sheet', {
      x: MARGIN + 14,
      y: PAGE_H - 282,
      size: 13,
      font: fontBold,
      color: COLORS.primary,
    });

    page.drawText(`Experiment: ${REPORT_CONFIG.experimentName}`, {
      x: MARGIN + 14,
      y: PAGE_H - 305,
      size: 10,
      font: fontRegular,
      color: COLORS.secondary,
    });

    page.drawText(`Generated at: ${safeText(log?.generatedAt)}`, {
      x: MARGIN + 14,
      y: PAGE_H - 323,
      size: 10,
      font: fontRegular,
      color: COLORS.secondary,
    });

    page.drawText(`Event period: ${period.start}  →  ${period.end}`, {
      x: MARGIN + 14,
      y: PAGE_H - 341,
      size: 10,
      font: fontRegular,
      color: COLORS.secondary,
    });

    page.drawText(`Total lifecycle events: ${events.length}`, {
      x: MARGIN + 14,
      y: PAGE_H - 359,
      size: 10,
      font: fontRegular,
      color: COLORS.secondary,
    });

    page.drawText(`Total CPS involved: ${grouped.length}`, {
      x: MARGIN + 14,
      y: PAGE_H - 377,
      size: 10,
      font: fontRegular,
      color: COLORS.secondary,
    });

    page.drawText(REPORT_CONFIG.prototypeVersion, {
      x: MARGIN,
      y: 72,
      size: 10,
      font: fontRegular,
      color: COLORS.lightText,
    });

    page.drawText(`Report language: ${REPORT_CONFIG.reportLanguage}`, {
      x: MARGIN,
      y: 56,
      size: 10,
      font: fontRegular,
      color: COLORS.lightText,
    });

    // PÁGINA 2
    addPage();

    drawSectionTitle('1. Executive Summary');
    drawWrappedParagraph('Architecture: ', REPORT_CONFIG.architectureName);
    drawWrappedParagraph('Institutions: ', `${REPORT_CONFIG.institutionLine1}; ${REPORT_CONFIG.institutionLine2}`);
    drawWrappedParagraph('Lifecycle phase: ', 'Plug Phase');
    drawWrappedParagraph('Purpose: ', 'Provide a readable academic and technical report for CPS onboarding, registration history, state transitions, and lifecycle event evidence.');
    drawWrappedParagraph('Experiment: ', REPORT_CONFIG.experimentName);
    drawWrappedParagraph('Prototype version: ', REPORT_CONFIG.prototypeVersion);
    drawWrappedParagraph('Event registry source: ', 'plug-phase-log.json');
    drawWrappedParagraph('Event period: ', `${period.start} → ${period.end}`);
    drawDivider();

    drawSectionTitle('2. Global Indicators');
    const kpiTop = y;
    drawKpiCard(MARGIN, kpiTop, 120, 58, 'Total events', events.length, COLORS.primary);
    drawKpiCard(MARGIN + 128, kpiTop, 120, 58, 'CPS involved', grouped.length, COLORS.primary);
    drawKpiCard(MARGIN + 256, kpiTop, 120, 58, 'Registrations', counters.registration, rgb(0.10, 0.45, 0.85));
    drawKpiCard(MARGIN + 384, kpiTop, 120, 58, 'Play transitions', counters.play, rgb(0.08, 0.55, 0.28));
    y -= 72;

    drawKpiCard(MARGIN, y, 120, 58, 'Unplug events', counters.unplug, rgb(0.78, 0.17, 0.17));
    drawKpiCard(MARGIN + 128, y, 120, 58, 'Maintenance', counters.maintenance, rgb(0.82, 0.53, 0.10));
    drawKpiCard(MARGIN + 256, y, 120, 58, 'Other events', counters.other, rgb(0.35, 0.42, 0.52));
    y -= 78;

    drawDivider();

    drawSectionTitle('3. CPS Portfolio Overview');
    for (const group of grouped) {
      ensureSpace(54);
      page.drawRectangle({
        x: MARGIN,
        y: y - 6,
        width: PAGE_W - MARGIN * 2,
        height: 44,
        color: rgb(0.975, 0.985, 1),
        borderColor: COLORS.border,
        borderWidth: 1,
      });

      drawText(group.cpsName, MARGIN + 10, y + 14, {
        size: 11,
        font: fontBold,
        color: COLORS.primary,
      });

      drawText(
        `CPS ID: ${safeText(group.cpsId)}   |   Topic: ${safeText(group.topic)}   |   Events: ${group.events.length}`,
        MARGIN + 10,
        y - 2,
        {
          size: 9,
          font: fontRegular,
          color: COLORS.secondary,
        }
      );

      y -= 56;
    }

    drawDivider();

    let sectionIndex = 4;
    for (const group of grouped) {
      drawSectionTitle(`${sectionIndex}. CPS Event Log`);
      drawCpsHeader(group, sectionIndex);
      drawTableHeader();

      group.events.forEach((evt, index) => {
        drawEventRow(evt, index);

        if (y < 90 && index < group.events.length - 1) {
          addPage();
          drawCpsHeader(group, sectionIndex);
          drawTableHeader();
        }
      });

      y -= 6;
      drawDivider();
      sectionIndex += 1;
    }

    ensureSpace(220);
    drawSectionTitle(`${sectionIndex}. Event Classification Legend`);

    const legendTypes = [
      'cps_registered',
      'cps_moved_to_play',
      'cps_unplugged',
      'maintenance_started',
      'other_event',
    ];

    legendTypes.forEach((type) => {
      const item = classifyEvent(type);

      ensureSpace(28);
      page.drawRectangle({
        x: MARGIN,
        y: y - 4,
        width: PAGE_W - MARGIN * 2,
        height: 22,
        color: item.bg,
        borderColor: COLORS.border,
        borderWidth: 1,
      });

      page.drawRectangle({
        x: MARGIN,
        y: y - 4,
        width: 8,
        height: 22,
        color: item.color,
      });

      drawText(item.label, MARGIN + 16, y + 2, {
        size: 10,
        font: fontBold,
        color: item.color,
      });

      y -= 30;
    });

    drawSectionTitle(`${sectionIndex + 1}. Closing Note`);
    drawWrappedParagraph(
      'Statement: ',
      'This report was automatically generated from the Plug Phase event registry maintained by ACSM. It is intended to support lifecycle traceability, human-readable validation, experimental documentation, and academic reporting.'
    );

    // PAGINAÇÃO
    const totalPages = pages.length;
    pages.forEach((p, index) => addFooter(p, index + 1, totalPages));

    const pdfBytes = await pdfDoc.save();
    const fileName = `ufsc-nova-fct-acsm-plug-phase-report-${new Date()
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