import * as cheerio from "cheerio";
import type { ClearanceProduct, ClearanceSearchInput } from "../types.js";
import { findTargetStoresByZip } from "./stores.js";

const targetClearanceWeeklyAdUrl = "https://www.target.com/c/clearance/weekly-ad/-/N-5q0gaZ55dgn";

function parseMoney(value: string) {
  const match = value.match(/\$([0-9]+(?:\.[0-9]{2})?)/);
  return match ? Number(match[1]) : undefined;
}

function parseRegularPrice(value: string) {
  const match = value.match(/reg\s+\$([0-9]+(?:\.[0-9]{2})?)/i);
  return match ? Number(match[1]) : undefined;
}

function parseTcin(url: string | undefined) {
  if (!url) {
    return undefined;
  }

  const match = url.match(/\/A-(\d+)/);
  return match?.[1];
}

function absoluteTargetUrl(href: string | undefined) {
  if (!href) {
    return undefined;
  }

  return href.startsWith("http") ? href : `https://www.target.com${href}`;
}

export async function searchTargetPublicClearance(
  input: ClearanceSearchInput
): Promise<ClearanceProduct[]> {
  const storeLookup = await findTargetStoresByZip(input.zipCode);
  const primaryStore = storeLookup.stores[0];
  const limit = input.limit ?? 100;
  const products: ClearanceProduct[] = [];
  const seen = new Set<string>();

  for (let offset = 0; products.length < limit; offset += 24) {
    const pageProducts = await fetchTargetClearancePage({
      input,
      offset,
      primaryStore,
      storeLookupWarning: storeLookup.warning,
      seen
    });

    products.push(...pageProducts);

    if (pageProducts.length === 0 || pageProducts.length < 24) {
      break;
    }
  }

  return products.slice(0, limit);
}

type FetchTargetClearancePageInput = {
  input: ClearanceSearchInput;
  offset: number;
  primaryStore: Awaited<ReturnType<typeof findTargetStoresByZip>>["stores"][number] | undefined;
  storeLookupWarning: string | undefined;
  seen: Set<string>;
};

async function fetchTargetClearancePage({
  input,
  offset,
  primaryStore,
  storeLookupWarning,
  seen
}: FetchTargetClearancePageInput): Promise<ClearanceProduct[]> {
  const url = new URL(targetClearanceWeeklyAdUrl);
  url.searchParams.set("Nao", String(offset));
  if (primaryStore?.storeId) {
    url.searchParams.set("store_id", primaryStore.storeId);
  }

  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
      "user-agent":
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ScannerAz/0.1; +https://localhost)"
    }
  });

  if (!response.ok) {
    throw new Error(`Target public clearance request failed: ${response.status}`);
  }

  const html = await response.text();
  const seoHtml = html.includes("product-card-price")
    ? html
    : await fetchSeoClearanceHtml(offset);
  const $ = cheerio.load(seoHtml);
  const text = $("body").text().replace(/\s+/g, " ").trim();
  const products: ClearanceProduct[] = [];

  $("[id^='product-card-price-']").each((_index, element) => {
    const priceBlock = $(element);
    const wrapper = priceBlock.parent().parent().parent().parent();
    const link = wrapper.find("a[href*='/p/'][aria-label]").first();
    const fallbackLink = wrapper.find("a[href*='/p/']").first();
    const href = (link.length ? link : fallbackLink).attr("href");
    const productUrl = absoluteTargetUrl(href);
    const tcin = parseTcin(productUrl);
    const nearbyText = wrapper.text().replace(/\s+/g, " ").trim();
    const title =
      link.attr("aria-label")?.replace(/\s+/g, " ").trim() ||
      link.find("[title]").first().attr("title")?.replace(/\s+/g, " ").trim() ||
      link.text().replace(/\s+/g, " ").trim();
    const candidateText = nearbyText || title;

    if (!productUrl || !tcin || seen.has(tcin)) {
      return;
    }

    if (!/(clearance|sale|reg\s+\$)/i.test(candidateText)) {
      return;
    }

    const price = parseMoney(candidateText);
    const regularPrice = parseRegularPrice(candidateText);
    const discountPercent =
      regularPrice && price ? Math.round(((regularPrice - price) / regularPrice) * 100) : undefined;

    seen.add(tcin);
    products.push({
      retailer: "target",
      provider: "public-web",
      title: title || candidateText.slice(0, 180),
      url: productUrl,
      retailerProductId: tcin,
      price,
      regularPrice,
      discountPercent,
      availability: "weekly-ad",
      raw: {
        zipCode: input.zipCode,
        offset,
        store: primaryStore,
        storeLookupWarning,
        excerpt: candidateText.slice(0, 500)
      }
    });
  });

  if (products.length > 0) {
    return products;
  }

  const fallbackMatches = text.matchAll(
    /\$[0-9]+(?:\.[0-9]{2})?.{0,80}reg\s+\$[0-9]+(?:\.[0-9]{2})?.{0,220}?(?:Sale|Clearance)/gi
  );

  for (const match of fallbackMatches) {
    const excerpt = match[0].trim();
    const price = parseMoney(excerpt);
    const regularPrice = parseRegularPrice(excerpt);

    products.push({
      retailer: "target",
      provider: "public-web",
      title: excerpt.slice(0, 180),
      price,
      regularPrice,
      discountPercent:
        regularPrice && price ? Math.round(((regularPrice - price) / regularPrice) * 100) : undefined,
      availability: "weekly-ad",
      raw: {
        zipCode: input.zipCode,
        offset,
        store: primaryStore,
        storeLookupWarning,
        excerpt
      }
    });
  }

  return products;
}

async function fetchSeoClearanceHtml(offset: number) {
  const url = new URL(targetClearanceWeeklyAdUrl);
  url.searchParams.set("Nao", String(offset));

  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)"
    }
  });

  if (!response.ok) {
    throw new Error(`Target SEO clearance request failed: ${response.status}`);
  }

  return response.text();
}
