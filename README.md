# scannerAZ

ScannerAz is a small Express app for retail-to-Amazon product validation.

The current deployed page is a Walmart scan list with products confirmed as
sellable in Amazon/SellerAmp and visible UPC barcodes for quick lookup in the
Walmart app.

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm start
```

## Render

Use these settings:

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Health check path: `/health`
