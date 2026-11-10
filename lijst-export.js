// lijst-export.js — zet een getoonde lijst boekingen om in een Excel-bestand (alleen lezen, wijzigt geen gegevens).

import { grootboekNamen, rekeningNamen, kostenplaatsVan } from './storage.js?v=20261110i';

const PLUS = new Set(['inkomst', 'prive_storting']);
const SOORT = { inkomst: 'Inkomst', uitgave: 'Uitgave', prive_storting: 'Privé storting', prive_opname: 'Privé opname' };

/** rijen = boekingen zoals op het scherm; bestandsnaam zonder .xlsx. Geeft aantal regels terug. */
export function schrijfLijstNaarExcel(rijen, bestandsnaam, bladnaam = 'Boekingen') {
  const GB = grootboekNamen(), REK = rekeningNamen();
  const op = [...rijen].sort((a, b) => String(a.datum).localeCompare(String(b.datum)) || String(a.id).localeCompare(String(b.id)));
  let bij = 0, af = 0;
  const data = [['Datum', 'Naam', 'Omschrijving', 'Grootboek', 'Grootboeknaam', 'Rekening', 'Soort', 'Kostenplaats', 'Bij', 'Af']];
  op.forEach(t => {
    const b = Math.round(Number(t.bedrag) * 100) / 100;
    const plus = PLUS.has(t.type);
    if (plus) bij += b; else af += b;
    data.push([t.datum, t.naam || '', t.omschr || '', t.gb || '', GB[t.gb] || '', REK[t.rek] || t.rek || '', SOORT[t.type] || t.type || '', kostenplaatsVan(t.id), plus ? b : '', plus ? '' : b]);
  });
  data.push([]);
  data.push(['Totaal', '', '', '', '', '', '', '', Math.round(bij * 100) / 100, Math.round(af * 100) / 100]);
  data.push(['Netto (bij − af)', '', '', '', '', '', '', '', Math.round((bij - af) * 100) / 100]);
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 11 }, { wch: 32 }, { wch: 44 }, { wch: 10 }, { wch: 30 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 12 }];
  for (let r = 1; r <= op.length + 2; r++) for (const c of ['I', 'J']) { const cel = ws[c + (r + 1)]; if (cel && typeof cel.v === 'number') cel.z = '#,##0.00'; }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, bladnaam.slice(0, 31));
  XLSX.writeFile(wb, `${bestandsnaam}.xlsx`);
  return op.length;
}
