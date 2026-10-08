export const packs = Object.freeze({ coins_1500: 1500, coins_4000: 4000 });
// Must match the Flutter shop. Prices are virtual coins, not real currency.
export const items = Object.freeze({
  hint: 80, revive: 200,
  'companion:1': 600, 'companion:2': 700, 'companion:3': 800,
  'theme:sakura': 150, 'theme:lagoon': 180, 'theme:midnight': 220,
  'arrow:neon': 180, 'arrow:fire': 220, 'arrow:ice': 220,
  'arrow:sakura': 200, 'arrow:prism': 260,
});
export const permanent = sku => sku.startsWith('companion:') || sku.startsWith('theme:') || sku.startsWith('arrow:');
