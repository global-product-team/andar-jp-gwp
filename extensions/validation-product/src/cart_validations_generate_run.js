// @ts-check

const EGIFT_PRODUCT_ID = "";

const GWP_CONDITIONS = [
  {
    // thresholdAmount: 60000,
    productId: "",
    productTitle: "[3 SET] NEW andar オールデイフィット冷感ブラ",
    productQuantity: 3,
    giftProductId: "gid://shopify/Product/9405285236982",
  },
  {
    // thresholdAmount: 25000,
    productId: "gid://shopify/Product/8493669187830",
    productTitle: "airyfit ワイドパンツ",
    productQuantity: 3,
    giftProductId: "gid://shopify/Product/8831087837430",
  },
];

const ERROR_MESSAGE = "error product message.";

// ── 세트(번들) 그룹 ID 추출 ──────────────────────────────
function getBundleGroupId(line) {
  const value = line?.partOf?.value;
  if (!value) return null;

  const match = value.match(/\(group\s+([^)]+)\)/);
  return match ? match[1].trim() : null;
}

// ── 세트 상위 상품 타이틀 추출 (따옴표 종류 무관하게 처리) ──
function getBundleTitle(line) {
  const value = line?.partOf?.value;
  if (!value) return null;

  const match = value.match(/Bundle\s+(.+?)\s*\(group\s+[^)]+\)\s*$/);
  if (!match) return null;

  let title = match[1].trim();

  while (title.length && !/[\[\]a-zA-Z0-9ぁ-んァ-ヶ一-龯]/.test(title[0])) {
    title = title.slice(1);
  }
  while (title.length && !/[a-zA-Z0-9ぁ-んァ-ヶ一-龯]/.test(title[title.length - 1])) {
    title = title.slice(0, -1);
  }

  return title.trim();
}

// 세트는 1개, 단품은 quantity 그대로 합산
function getEffectiveQuantity(lines) {
  const seenGroupIds = new Set();
  let total = 0;
  for (const line of lines) {
    const groupId = getBundleGroupId(line);
    if (groupId) {
      if (!seenGroupIds.has(groupId)) {
        seenGroupIds.add(groupId);
        total += 1;
      }
    } else {
      total += Number(line.quantity || 0);
    }
  }
  return total;
}

function getProductLines(cartLines, condition) {
  if (condition.productId) {
    return cartLines.filter((line) => {
      if (line?.merchandise?.__typename !== "ProductVariant") return false;
      if (line?.merchandise?.product?.id !== condition.productId) return false;

      // 세트 구성품이면 단품 조건 매칭에서 제외
      const isPartOfBundle = !!getBundleGroupId(line);
      if (isPartOfBundle) return false;

      return true;
    });
  }

  // productId가 빈 문자열이거나 없으면 (세트 전용 조건) 타이틀 매칭
  return cartLines.filter((line) => {
    if (line?.merchandise?.__typename !== "ProductVariant") return false;
    const bundleTitle = getBundleTitle(line);
    return bundleTitle && bundleTitle === condition.productTitle;
  });
}

export function cartValidationsGenerateRun(input) {
  const step = input.buyerJourney?.step;
  const VALIDATE_STEPS = ["CHECKOUT_INTERACTION", "CHECKOUT_COMPLETION"];

  if (!VALIDATE_STEPS.includes(step)) {
    return { operations: [{ validationAdd: { errors: [] } }] };
  }

  // 테스트 고객만 validation 동작
  // const tagResults = input?.cart?.buyerIdentity?.customer?.hasTags ?? [];
  // const isTestCustomer = tagResults.some(
  //   (tag) => tag?.tag === "gwp-test" && tag?.hasTag === true
  // );

  // if (!isTestCustomer) {
  //   return { operations: [{ validationAdd: { errors: [] } }] };
  // }

  const metaobject = input?.shop?.metaobject;
  if (!metaobject) {
    return { operations: [{ validationAdd: { errors: [] } }] };
  }

  const conditionTypes = parseConditionTypes(metaobject?.condition_type?.value);
  if (!conditionTypes.includes("product")) {
    return { operations: [{ validationAdd: { errors: [] } }] };
  }

  const isCampaignPeriod = input?.shop?.localTime?.isCampaignPeriod;
  if (!isCampaignPeriod) {
    return { operations: [{ validationAdd: { errors: [] } }] };
  }

  const cartLines = input?.cart?.lines ?? [];
  const cartTotalAmount = Number(input?.cart?.cost?.totalAmount?.amount || 0);

  const eGiftAmount = cartLines.reduce((sum, line) => {
    if (line?.merchandise?.__typename !== "ProductVariant") return sum;
    if (line?.merchandise?.product?.id !== EGIFT_PRODUCT_ID) return sum;
    return sum + Number(line?.cost?.totalAmount?.amount || 0);
  }, 0);

  const totalAmount = cartTotalAmount - eGiftAmount;

  const sortedConditions = [...GWP_CONDITIONS].sort((a, b) => {
    if (conditionTypes.includes("amount")) {
      const amountDiff = Number(b.thresholdAmount || 0) - Number(a.thresholdAmount || 0);
      if (amountDiff !== 0) return amountDiff;
    }

    const productDiff = Number(b.productQuantity || 1) - Number(a.productQuantity || 1);
    if (productDiff !== 0) return productDiff;

    return 0;
  });

  const eligibleCondition = sortedConditions.find((condition) => {
    const amountOk = (() => {
      if (!conditionTypes.includes("amount")) return true;
      return totalAmount >= (condition.thresholdAmount || 0);
    })();

    if (!amountOk) return false;

    const productOk = (() => {
      if (!condition.productTitle) return false;

      const productLines = getProductLines(cartLines, condition);
      const productQty = getEffectiveQuantity(productLines);

      return productQty >= (condition.productQuantity || 1);
    })();

    return productOk;
  });

  if (!eligibleCondition) {
    return { operations: [{ validationAdd: { errors: [] } }] };
  }

  const cartProductIds = cartLines
    .map((line) => {
      if (line?.merchandise?.__typename !== "ProductVariant") return null;
      return line?.merchandise?.product?.id ?? null;
    })
    .filter(Boolean);

  const hasGift = cartProductIds.includes(eligibleCondition.giftProductId);
  const errors = hasGift ? [] : [{ message: ERROR_MESSAGE, target: "$.cart" }];

  return { operations: [{ validationAdd: { errors } }] };
}

function parseConditionTypes(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [value];
  }
}