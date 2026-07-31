// @ts-check

/**
 * 조건 설정값
 * conditionTypes는 메타오브젝트에서 읽어옴
 * collectionId, giftProductId는 하드코딩 유지
 * inCollections ids도 run.graphql에 동일하게 유지
 */

const EGIFT_PRODUCT_ID = "";

const GWP_CONDITIONS = [
  {
    // thresholdAmount: 20000,
    collectionId: "gid://shopify/Collection/492844744950",
    collectionQuantity: 3,
    // collectionOnly: false,
    giftProductId: "gid://shopify/Product/8831087837430",
  },
  {
    // thresholdAmount: 20000,
    collectionId: "gid://shopify/Collection/485328355574",
    collectionQuantity: 2,
    // collectionOnly: false,
    giftProductId: "gid://shopify/Product/9033242575094",
  },
  
  
  {
    // thresholdAmount: 80000,
    collectionId: "gid://shopify/Collection/492844744950",
    collectionQuantity: 2,
    // collectionOnly: true,
    giftProductId: "gid://shopify/Product/9405285236982",
  },
];

const ERROR_MESSAGE = "決済前に、プレゼントを[Add]で追加してください。";
  

// ── 라인 실지불 금액 계산 ──────────────────────────────
function getLineActualAmount(line) {
  const subtotal = Number(line?.cost?.subtotalAmount?.amount || 0);
  const discounted = (line?.discountAllocations || []).reduce(
    (sum, d) => sum + Number(d?.discountedAmount?.amount || 0),
    0
  );
  return subtotal - discounted;
}

// ── 세트(번들) 그룹 ID 추출 ──────────────────────────────
function getBundleGroupId(line) {
  const value = line?.partOf?.value; // attribute → partOf로 수정
  if (!value) return null;

  const match = value.match(/\(group\s+([^)]+)\)/);
  return match ? match[1].trim() : null;
}

// ── 세트는 1개, 단품은 quantity 그대로 합산 ───────────────
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

  // ── 메타오브젝트에서 conditionTypes, 캠페인 기간 읽기 ────────

  const metaobject = input?.shop?.metaobject;

  if (!metaobject) {
    return { operations: [{ validationAdd: { errors: [] } }] };
  }

  const conditionTypes = parseConditionTypes(metaobject?.condition_type?.value);

  if (!conditionTypes.includes("collection")) {
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

     return sum + getLineActualAmount(line);
  }, 0);

  const totalAmount = cartTotalAmount - eGiftAmount;

  // ── eligible condition 찾기 ──────────────────────────────

  const sortedConditions = [...GWP_CONDITIONS]
    // .filter((c) => {
    //   if (conditionTypes.includes("amount")) {
    //     return c.currencyCode === currencyCode;
    //   }
    //   return true;
    // })
    .sort((a, b) => {
      const amountDiff = (b.thresholdAmount || 0) - (a.thresholdAmount || 0);
      if (amountDiff !== 0) return amountDiff;
      return (b.collectionQuantity || 0) - (a.collectionQuantity || 0);
    });

  const eligibleCondition = sortedConditions.find((condition) => {
    const amountOk = (() => {
      if (!conditionTypes.includes("amount")) return true;
      if (condition.collectionOnly) return true; // ← 추가
      return totalAmount >= (condition.thresholdAmount || 0);
    })();

    if (!amountOk) return false; // ← 추가 (early return)

    const collectionOk = (() => {
      if (!conditionTypes.includes("collection")) return true;
      if (!condition.collectionId) return false;

      const collectionLines = cartLines.filter((line) => {
        if (line?.merchandise?.__typename !== "ProductVariant") return false;
        if (line?.merchandise?.product?.id === EGIFT_PRODUCT_ID) return false;

        const inCollections = line?.merchandise?.product?.inCollections || [];
        return inCollections.some(
          (c) => c.collectionId === condition.collectionId && c.isMember === true
        );
      });

      const collectionQty = getEffectiveQuantity(collectionLines); // 기존 reduce 대체

      if (collectionQty < (condition.collectionQuantity || 1)) {
        return false;
      }

      if (condition.collectionOnly) {
         const collectionAmount = collectionLines.reduce((sum, line) => {
          return sum + getLineActualAmount(line);
        }, 0);

        return collectionAmount >= (condition.thresholdAmount || 0);
      }

      return true;
    })();

    return collectionOk; // ← amountOk는 위에서 이미 처리했으므로
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

   const errors = hasGift ? [] : [{ message: ERROR_MESSAGE, target: "$.cart" }];

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

