import { expect, test, type Locator } from '@playwright/test';

async function contrast(chip: Locator) {
  return chip.evaluate(el => {
    const luminance = (color: string) => {
      const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(c => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const chip = getComputedStyle(el);
    const sheet = getComputedStyle(el.closest('.first-spend-sheet')!);
    return { edge: ratio(chip.borderTopColor, sheet.backgroundColor), innerEdge: ratio(chip.borderTopColor, chip.backgroundColor), text: ratio(chip.color, chip.backgroundColor) };
  });
}

for (const theme of ['dark', 'light']) for (const lang of ['en', 'da']) {
  test(`preset idle and hover edges meet 3:1 (${theme}, ${lang})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/tests/fixtures/first-spend.html?theme=${theme}&lang=${lang}`);
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
    await page.locator('.first-spend-options summary').click();
    const chip = page.locator('[data-preset="everyday"]');
    await expect(chip).toHaveAttribute('aria-checked', 'false');
    for (const hover of [false, true]) {
      if (hover) await chip.hover();
      const ratios = await contrast(chip);
      expect(ratios.edge, `hover=${hover}, outer edge`).toBeGreaterThanOrEqual(3);
      expect(ratios.innerEdge, `hover=${hover}, inner edge`).toBeGreaterThanOrEqual(3);
      expect(ratios.text).toBeGreaterThanOrEqual(4.5);
    }
    await chip.click();
    await expect(chip).toHaveAttribute('aria-checked', 'true');
    const selected = await contrast(chip);
    expect(selected.edge).toBeGreaterThanOrEqual(3);
    expect(selected.text).toBeGreaterThanOrEqual(4.5);
    expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.locator('.first-spend-options .presets').evaluate(el => ({ display: getComputedStyle(el).display, wrap: getComputedStyle(el).flexWrap }))).toEqual({ display: 'flex', wrap: 'wrap' });
  });
}
