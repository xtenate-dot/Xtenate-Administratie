// excel-ui.js — het venster rond de Excel-export.

import { beschikbareJaren, exportSamenvatting, exporteerNaarExcel } from './export.js?v=20261023x';
import { lopendJaar } from './jaren.js?v=20261023x';

const el = id => document.getElementById(id);

export function openExportModal() {
  const sel = el('export-jaar');
  const jaren = beschikbareJaren();
  sel.innerHTML = jaren.map(j => `<option value="${j}">${j}</option>`).join('');
  sel.value = jaren.includes(lopendJaar()) ? lopendJaar() : jaren[0];
  toonExportSamenvatting();
  el('modal-export').classList.add('open');
}

export function sluitExportModal() { el('modal-export').classList.remove('open'); }

export function toonExportSamenvatting() {
  const jaar = el('export-jaar').value;
  const s = exportSamenvatting(jaar);
  el('export-samenvatting').innerHTML = s.boekingen === 0
    ? `<div class="alert alert-warn">Er staan geen boekingen in ${jaar}. Het bestand bevat dan alleen je voorraad en loten.</div>`
    : `<div class="alert alert-info">
        <div>${s.maanden} maandbladen · ${s.bank} bankboekingen · ${s.creditkaart} creditkaartboekingen · ${s.artikelen} artikelen · ${s.loten} HNVI-loten</div>
      </div>`;
}

export function doeExport() {
  const jaar = el('export-jaar').value;
  try {
    const s = exporteerNaarExcel(jaar);
    sluitExportModal();
    console.info(`Administratie_${jaar}.xlsx aangemaakt`, s);
  } catch (e) {
    el('export-samenvatting').innerHTML =
      `<div class="alert alert-error">Het bestand kon niet worden aangemaakt: ${e.message}</div>`;
  }
}
