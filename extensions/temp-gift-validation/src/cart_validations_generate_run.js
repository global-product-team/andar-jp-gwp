// @ts-check

const VALIDATE_STEPS = ["CHECKOUT_INTERACTION", "CHECKOUT_COMPLETION"];

const BLOCKED_PRODUCT_IDS = [
  "gid://shopify/Product/9365820571894",
  "gid://shopify/Product/9364142293238",
];

export function cartValidationsGenerateRun(input) {
  const step = input?.buyerJourney?.step;

  if (!VALIDATE_STEPS.includes(step)) {
    return { operations: [] };
  }

  const lines = input?.cart?.lines ?? [];

  const hasOnlyBlockedProducts =
    lines.length > 0 &&
    lines.every((line) => {
      const merchandise = line?.merchandise;

      if (merchandise?.__typename !== "ProductVariant") {
        return false;
      }

      return BLOCKED_PRODUCT_IDS.includes(merchandise?.product?.id);
    });

  if (!hasOnlyBlockedProducts) {
    return { operations: [] };
  }

  return {
    operations: [
      {
        validationAdd: {
          errors: [
            {
              message:
                "対象商品のみでのご注文はできません。他の商品を追加してください。",
              target: "$.cart",
            },
          ],
        },
      },
    ],
  };
}