// @ts-check

const GWP_CONDITIONS = [
  {
    currencyCode: "JPY",
    thresholdAmount: 200000,
    collectionId: "gid://shopify/Collection/491095523574",
    collectionQuantity: 1,
    collectionOnly: true,
    giftProductId: "gid://shopify/Product/9409886978294",
  },
];

const ERROR_MESSAGE = "決済前に、プレゼントを[Add]で追加してください。";

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

  if (!conditionTypes.length) {
    return { operations: [{ validationAdd: { errors: [] } }] };
  }

  const isCampaignPeriod = input?.shop?.localTime?.isCampaignPeriod;

  if (!isCampaignPeriod) {
    return { operations: [{ validationAdd: { errors: [] } }] };
  }

  // ── 카트 데이터 ──────────────────────────────────────────────

  const totalAmount = Number(input?.cart?.cost?.totalAmount?.amount ?? 0);
  const currencyCode = input?.cart?.cost?.totalAmount?.currencyCode;
  const cartLines = input?.cart?.lines ?? [];

  // ── eligible condition 찾기 ──────────────────────────────────

  const sortedConditions = [...GWP_CONDITIONS]
    .filter((c) => c.currencyCode === currencyCode)
    .sort((a, b) => (b.thresholdAmount || 0) - (a.thresholdAmount || 0));

  const eligibleCondition = sortedConditions.find((condition) => {
    // ── amount 조건 ──────────────────────────────────────────
    const amountOk = (() => {
      if (!conditionTypes.includes("amount")) return true;
      // collectionOnly: amount 체크는 collection 단계에서 처리
      if (condition.collectionOnly) return true;
      return totalAmount >= (condition.thresholdAmount || 0);
    })();

    if (!amountOk) return false;

    // ── collection 조건 ──────────────────────────────────────
    const collectionOk = (() => {
      if (!conditionTypes.includes("collection")) return true;
      if (!condition.collectionId) return false;

      if (condition.collectionOnly) {
        // 전체 할인율 계산
        const cartTotal = Number(input?.cart?.cost?.totalAmount?.amount || 0);
        const cartLineTotal = cartLines.reduce((sum, line) => {
          return sum + Number(line?.cost?.totalAmount?.amount || 0);
        }, 0);
        const discountRatio = cartLineTotal > 0 ? cartTotal / cartLineTotal : 1;

        // 컬렉션 상품 금액에 할인율 적용
        const collectionAmount = cartLines.reduce((sum, line) => {
          if (line?.merchandise?.__typename !== "ProductVariant") return sum;

          const inCollections = line?.merchandise?.product?.inCollections || [];
          const isMember = inCollections.some(
            (c) => c.collectionId === condition.collectionId && c.isMember === true
          );

          if (!isMember) return sum;

          const linePrice = Number(line?.cost?.totalAmount?.amount || 0);
          return sum + linePrice * discountRatio;
        }, 0);

        return collectionAmount >= (condition.thresholdAmount || 0);
      }

      // 기존 로직: 컬렉션 내 수량 체크
      const collectionQty = cartLines.reduce((sum, line) => {
        if (line?.merchandise?.__typename !== "ProductVariant") return sum;

        const inCollections = line?.merchandise?.product?.inCollections || [];
        const isMember = inCollections.some(
          (c) => c.collectionId === condition.collectionId && c.isMember === true
        );

        return isMember ? sum + Number(line.quantity || 0) : sum;
      }, 0);

      return collectionQty >= (condition.collectionQuantity || 1);
    })();

    return collectionOk;
  });

    // ── 조건 미달인데 gift product가 남아있는 경우 차단 ─────────────

  const cartProductIdsForGiftCheck = cartLines
    .map((line) => {
      if (line?.merchandise?.__typename !== "ProductVariant") return null;
      return line?.merchandise?.product?.id ?? null;
    })
    .filter(Boolean);

  const giftProductIds = sortedConditions
    .map((condition) => condition.giftProductId)
    .filter(Boolean);

  const hasAnyGiftInCart = cartProductIdsForGiftCheck.some((productId) =>
    giftProductIds.includes(productId)
  );

  if (!eligibleCondition && hasAnyGiftInCart) {
    return {
      operations: [
        {
          validationAdd: {
            errors: [
              {
                message:
                  "プレゼント条件を満たしていません。",
                target: "$.cart",
              },
            ],
          },
        },
      ],
    };
  }

  if (!eligibleCondition) {
    return { operations: [{ validationAdd: { errors: [] } }] };
  }

  // ── gift product 카트 여부 확인 ───────────────────────────────

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

// ── 유틸 ─────────────────────────────────────────────────────────

function parseConditionTypes(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [value];
  }
}