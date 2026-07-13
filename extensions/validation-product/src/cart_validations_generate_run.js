// @ts-check

/**
 * 조건 설정값
 * conditionTypes는 메타오브젝트에서 읽어옴
 * productId, giftProductId는 하드코딩 유지
 */

const EGIFT_PRODUCT_ID = "";

const GWP_CONDITIONS = [
  {
    thresholdAmount: 300,
    productId: "gid://shopify/Product/9969896194362",
    productQuantity: 1,
    giftProductId: "gid://shopify/Product/9586465866042",
  },
  {
    thresholdAmount: 400,
    productId: "gid://shopify/Product/9921523351866",
    productQuantity: 2,
    giftProductId: "gid://shopify/Product/10143139397946",
  },
  {
    thresholdAmount: 500,
    productId: "gid://shopify/Product/9921523351866",
    productQuantity: 3,
    giftProductId: "gid://shopify/Product/9969896358202",
  },
];

const ERROR_MESSAGE = "error product message.";

export function cartValidationsGenerateRun(input) {
  const step = input.buyerJourney?.step;
  const VALIDATE_STEPS = ["CHECKOUT_INTERACTION", "CHECKOUT_COMPLETION"];

  if (!VALIDATE_STEPS.includes(step)) {
    return { operations: [{ validationAdd: { errors: [] } }] };
  }

  // // 테스트 고객만 validation 동작
  // const tagResults = input?.cart?.buyerIdentity?.customer?.hasTags ?? [];
  // const isTestCustomer = tagResults.some(
  //   (tag) => tag?.tag === "gwp-test" && tag?.hasTag === true
  // );

  // if (!isTestCustomer) {
  //   return { operations: [{ validationAdd: { errors: [] } }] };
  // }

  // ── 메타오브젝트에서 conditionTypes, 캠페인 기간 읽기 ────────

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

  // ── 카트 데이터 ──────────────────────────────────────────

  const currencyCode = "JPY";
  const cartLines = input?.cart?.lines ?? [];
  const cartTotalAmount = Number(input?.cart?.cost?.totalAmount?.amount || 0);

  const eGiftAmount = cartLines.reduce((sum, line) => {
    if (line?.merchandise?.__typename !== "ProductVariant") return sum;
    if (line?.merchandise?.product?.id !== EGIFT_PRODUCT_ID) return sum;

    return sum + Number(line?.cost?.totalAmount?.amount || 0);
  }, 0);

  const totalAmount = cartTotalAmount - eGiftAmount;
  // ── eligible condition 찾기 ──────────────────────────────

 const sortedConditions = [...GWP_CONDITIONS]
  // .filter((condition) => {
  //   if (conditionTypes.includes("amount")) {
  //     return condition.currencyCode === currencyCode;
  //   }

  //   return true;
  // })
  .sort((a, b) => {
    if (conditionTypes.includes("amount")) {
      const amountDiff =
        Number(b.thresholdAmount || 0) -
        Number(a.thresholdAmount || 0);

      if (amountDiff !== 0) return amountDiff;
    }

    const productDiff =
      Number(b.productQuantity || 1) -
      Number(a.productQuantity || 1);

    if (productDiff !== 0) return productDiff;

    return 0;
  });

  const eligibleCondition = sortedConditions.find((condition) => {
    // ── amount 조건 ──────────────────────────────────────
    const amountOk = (() => {
      if (!conditionTypes.includes("amount")) return true;
      return totalAmount >= (condition.thresholdAmount || 0);
    })();

    if (!amountOk) return false;

    // ── product 수량 조건 ─────────────────────────────────
    const productOk = (() => {
      if (!condition.productId) return false;

      const productQty = cartLines.reduce((sum, line) => {
        if (line?.merchandise?.__typename !== "ProductVariant") return sum;
        if (line?.merchandise?.product?.id !== condition.productId) return sum;
        return sum + Number(line.quantity || 0);
      }, 0);

      return productQty >= (condition.productQuantity || 1);
    })();

    return productOk;
  });

  if (!eligibleCondition) {
    return { operations: [{ validationAdd: { errors: [] } }] };
  }

  // ── gift product 카트 여부 확인 ───────────────────────────

  const cartProductIds = cartLines
    .map((line) => {
      if (line?.merchandise?.__typename !== "ProductVariant") return null;
      return line?.merchandise?.product?.id ?? null;
    })
    .filter(Boolean);

  const hasGift = cartProductIds.includes(eligibleCondition.giftProductId);

  const errors = hasGift
    ? []
    : [{ message: ERROR_MESSAGE, target: "$.cart" }];

  return { operations: [{ validationAdd: { errors } }] };
}

// ── 유틸 함수 ───────────────────────────────────────────────

function parseConditionTypes(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [value];
  }
}