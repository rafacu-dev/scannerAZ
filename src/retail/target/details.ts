import * as cheerio from "cheerio";

export type TargetProductDetails = {
  tcin: string;
  url: string;
  title?: string;
  brand?: string;
  description?: string;
  gtin13?: string;
  price?: number;
  regularPrice?: number;
  availability?: string;
  imageUrl?: string;
};

function parseJsonLdObjects(html: string) {
  const $ = cheerio.load(html);
  const objects: unknown[] = [];

  $("script[type='application/ld+json']").each((_index, element) => {
    const content = $(element).contents().text();
    if (!content.trim()) {
      return;
    }

    try {
      const parsed = JSON.parse(content) as unknown;
      if (Array.isArray(parsed)) {
        objects.push(...parsed);
      } else {
        objects.push(parsed);
      }
    } catch {
      // Ignore malformed JSON-LD blocks; Target may include unrelated scripts.
    }
  });

  return objects;
}

function findProductJsonLd(objects: unknown[]): Record<string, unknown> | undefined {
  return objects.find((item): item is Record<string, unknown> => {
    if (!item || typeof item !== "object") {
      return false;
    }

    const type = (item as Record<string, unknown>)["@type"];
    return type === "Product" || (Array.isArray(type) && type.includes("Product"));
  });
}

function parseNumber(value: unknown) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Number(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getOffer(product: Record<string, unknown>) {
  const offers = product.offers;
  if (Array.isArray(offers)) {
    return offers[0] as Record<string, unknown> | undefined;
  }

  return offers && typeof offers === "object" ? (offers as Record<string, unknown>) : undefined;
}

function getRegularPrice(offer: Record<string, unknown> | undefined) {
  const specs = offer?.priceSpecification;
  if (!Array.isArray(specs)) {
    return undefined;
  }

  const strikethrough = specs.find((spec): spec is Record<string, unknown> => {
    return Boolean(
      spec &&
        typeof spec === "object" &&
        String((spec as Record<string, unknown>).priceType ?? "").includes("StrikethroughPrice")
    );
  });

  return parseNumber(strikethrough?.price);
}

function parseImage(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }

  return undefined;
}

function parseGtin13FromHtml(html: string) {
  const match = html.match(/"gtin13"\s*:\s*"(\d{13})"/);
  return match?.[1];
}

function parseStringFieldFromHtml(html: string, field: string) {
  const match = html.match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"])*)"`, "i"));
  if (!match?.[1]) {
    return undefined;
  }

  return match[1]
    .replace(/\\"/g, '"')
    .replace(/\\u0026/g, "&")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseOfferPriceFromHtml(html: string) {
  const match = html.match(/"offers"\s*:\s*\{[\s\S]{0,500}?"price"\s*:\s*"([0-9]+(?:\.[0-9]{2})?)"/);
  return match?.[1] ? Number(match[1]) : undefined;
}

function parseRegularPriceFromHtml(html: string) {
  const match = html.match(
    /"price"\s*:\s*"([0-9]+(?:\.[0-9]{2})?)"\s*,\s*"priceCurrency"\s*:\s*"USD"\s*,\s*"priceType"\s*:\s*"https:\/\/schema\.org\/StrikethroughPrice"/
  );
  return match?.[1] ? Number(match[1]) : undefined;
}

export async function getTargetProductDetails(url: string, tcin: string): Promise<TargetProductDetails> {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)"
    }
  });

  if (!response.ok) {
    throw new Error(`Target product detail request failed for ${tcin}: ${response.status}`);
  }

  const html = await response.text();
  const product = findProductJsonLd(parseJsonLdObjects(html));
  const offer = product ? getOffer(product) : undefined;

  if (!product) {
    return {
      tcin,
      url,
      title: parseStringFieldFromHtml(html, "name"),
      brand: parseStringFieldFromHtml(html, "brand"),
      description: parseStringFieldFromHtml(html, "description"),
      gtin13: parseGtin13FromHtml(html),
      price: parseOfferPriceFromHtml(html),
      regularPrice: parseRegularPriceFromHtml(html),
      availability: parseStringFieldFromHtml(html, "availability"),
      imageUrl: parseStringFieldFromHtml(html, "image")
    };
  }

  return {
    tcin,
    url,
    title: typeof product.name === "string" ? product.name : undefined,
    brand:
      typeof product.brand === "string"
        ? product.brand
        : typeof (product.brand as Record<string, unknown> | undefined)?.name === "string"
          ? ((product.brand as Record<string, unknown>).name as string)
          : undefined,
    description: typeof product.description === "string" ? product.description : undefined,
    gtin13:
      typeof product.gtin13 === "string" ? product.gtin13 : parseGtin13FromHtml(html),
    price: parseNumber(offer?.price),
    regularPrice: getRegularPrice(offer),
    availability: typeof offer?.availability === "string" ? offer.availability : undefined,
    imageUrl: parseImage(product.image)
  };
}
