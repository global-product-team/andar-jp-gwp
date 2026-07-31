import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  useCartLines,
  useTotalAmount,
} from "@shopify/ui-extensions/checkout/preact";

export default function extension() {
  render(<Extension />, document.body);
}

const GWP_HANDLE = "app--379210334209--gwp-usymljaq";
const GWP_TYPE = "app--379210334209--gwp";

const EGIFT_PRODUCT_ID = "";
const CURRENCY_CODE = "JPY";

function Extension() {
  const cartLines = useCartLines();
  const total = useTotalAmount();

  useEffect(() => {
    console.log("[GWP DEBUG] discountAllocations detail",
      cartLines.filter(l => l.discountAllocations?.length).map(l => l.discountAllocations)
    );
  }, [cartLines]);

  const [gwp, setGwp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [productsWithCollections, setProductsWithCollections] = useState([]);

  const productIds = useMemo(() => {
    return [
      ...new Set(
        cartLines
          .map((line) => line?.merchandise?.product?.id)
          .filter(Boolean)
      ),
    ];
  }, [cartLines]);

  useEffect(() => {
    fetchGwp();
  }, []);

  useEffect(() => {
    if (!productIds.length) {
      setProductsWithCollections([]);
      return;
    }

    fetchProductCollections(productIds);
  }, [productIds.join(",")]);

  const conditions = useMemo(() => {
    return gwp?.conditions || [];
  }, [gwp]);

  const conditionTypes = useMemo(() => {
    return gwp?.conditionTypes || [];
  }, [gwp]);

  const giftProductIds = useMemo(() => {
    return conditions
      .map((condition) => condition.giftProduct?.id)
      .filter(Boolean);
  }, [conditions]);

  const collectionAmountConditions = useMemo(() => {
    if (!conditionTypes.includes("collection")) return [];
    if (!conditionTypes.includes("amount")) return [];

    return conditions
      .map((condition, originalIndex) => ({
        ...condition,
        originalIndex,
      }))
      .filter((condition) => {
        return (
          condition.collection?.id &&
          condition.currencyCode === CURRENCY_CODE
        );
      });
  }, [conditions, conditionTypes]);

  function getOrderLevelDiscountAmount(line) {
    return (line?.discountAllocations || []).reduce((sum, d) => {
      const isOrderLevel = d?.discountApplication?.targetSelection === "ALL";
      return isOrderLevel ? sum + Number(d?.discountedAmount?.amount || 0) : sum;
    }, 0);
  }

  const collectionAmountInfos = useMemo(() => {
    return collectionAmountConditions.map((condition) => {
      const collectionLines = cartLines.filter((line) => {
        const productId = line?.merchandise?.product?.id;

        if (!productId) return false;
        if (productId === EGIFT_PRODUCT_ID) return false;
        if (giftProductIds.includes(productId)) return false;

        const product = productsWithCollections.find(
          (item) => item.id === productId
        );

        return product?.collections?.nodes?.some(
          (collection) => collection.id === condition.collection.id
        );
      });

      const collectionQuantity = collectionLines.reduce((sum, line) => {
        return sum + Number(line.quantity || 0);
      }, 0);

      const collectionAmount = collectionLines.reduce((sum, line) => {
        return sum + Number(line?.cost?.totalAmount?.amount || 0);
      }, 0);

      const visibleCollectionAmount = collectionLines.reduce((sum, line) => {
        return sum + Number(line?.cost?.totalAmount?.amount || 0) + getOrderLevelDiscountAmount(line);
      }, 0); // 화면상 보이는 금액 (주문할인 빼기 전)

      const currentAmount = condition.collectionOnly ? collectionAmount : Number(total?.amount || 0);


      const thresholdAmount = Number(condition.thresholdAmount || 0);

      const isAmountMatched = currentAmount >= thresholdAmount;
      const wouldHaveMatchedWithoutOrderDiscount =
        condition.collectionOnly && visibleCollectionAmount >= thresholdAmount;

      const showDiscountNotice =
        condition.collectionOnly && wouldHaveMatchedWithoutOrderDiscount && !isAmountMatched;

      const requiredQuantity = Number(condition.collectionQuantity || 1);

      const remainingAmount = Math.max(
        thresholdAmount - currentAmount,
        0
      );

      const remainingQuantity = Math.max(
        requiredQuantity - collectionQuantity,
        0
      );

      const isQuantityMatched = collectionQuantity >= requiredQuantity;

      return {
        id: condition.id,
        originalIndex: condition.originalIndex,

        collectionId: condition.collection?.id,
        collectionOnly: condition.collectionOnly,

        collectionTitle: condition.collection?.title || "対象コレクション", //  condition.conditionTitle || 을 추가하면 gwp_condition 타이틀 고대로 가져옴

        currentAmount,
        thresholdAmount,
        remainingAmount,

        collectionQuantity,
        requiredQuantity,
        remainingQuantity,

        isAmountMatched,
        isQuantityMatched,
        isConditionMatched: isAmountMatched && isQuantityMatched,
      };
    });
  }, [
    collectionAmountConditions,
    cartLines,
    productsWithCollections,
    giftProductIds,
    total
  ]);

  const currentEligibleCondition = useMemo(() => {
    if (!collectionAmountInfos.length) return null;

    const relatedConditions = collectionAmountInfos.filter(
      (info) => info.collectionQuantity > 0
    );

    if (!relatedConditions.length) return null;

    const matchedConditions = relatedConditions.filter(
      (info) => info.isConditionMatched
    );

    if (!matchedConditions.length) return null;

    return [...matchedConditions].sort((a, b) => {
      const amountDiff =
        Number(b.thresholdAmount || 0) -
        Number(a.thresholdAmount || 0);

      if (amountDiff !== 0) return amountDiff;

      const quantityDiff =
        Number(b.requiredQuantity || 1) -
        Number(a.requiredQuantity || 1);

      if (quantityDiff !== 0) return quantityDiff;

      return (
        Number(a.originalIndex || 0) -
        Number(b.originalIndex || 0)
      );
    })[0];
  }, [collectionAmountInfos]);

  const activeProgressInfo = useMemo(() => {
    if (!collectionAmountInfos.length) return null;

    const relatedConditions = collectionAmountInfos.filter(
      (info) => info.collectionQuantity > 0
    );

    if (!relatedConditions.length) return null;

    // 현재 충족한 조건이 없는 경우:
    // 가장 낮은 조건부터 안내
    if (!currentEligibleCondition) {
      return [...relatedConditions].sort((a, b) => {
        const amountDiff =
          Number(a.thresholdAmount || 0) -
          Number(b.thresholdAmount || 0);

        if (amountDiff !== 0) return amountDiff;

        const quantityDiff =
          Number(a.requiredQuantity || 1) -
          Number(b.requiredQuantity || 1);

        if (quantityDiff !== 0) return quantityDiff;

        return (
          Number(a.originalIndex || 0) -
          Number(b.originalIndex || 0)
        );
      })[0];
    }

    // 현재 지급 조건과 동일한 조건군
    const sameGroupConditions = relatedConditions.filter((info) => {
      return (
        info.collectionId === currentEligibleCondition.collectionId &&
        info.collectionOnly === currentEligibleCondition.collectionOnly
      );
    });

    // 현재 조건보다 높은 조건 중 아직 미충족인 조건
    const nextCondition = sameGroupConditions
      .filter((info) => {
        if (info.isConditionMatched) return false;

        const hasHigherAmount =
          Number(info.thresholdAmount || 0) >
          Number(currentEligibleCondition.thresholdAmount || 0);

        const hasHigherQuantity =
          Number(info.requiredQuantity || 1) >
          Number(currentEligibleCondition.requiredQuantity || 1);

        return hasHigherAmount || hasHigherQuantity;
      })
      .sort((a, b) => {
        const amountDiff =
          Number(a.thresholdAmount || 0) -
          Number(b.thresholdAmount || 0);

        if (amountDiff !== 0) return amountDiff;

        const quantityDiff =
          Number(a.requiredQuantity || 1) -
          Number(b.requiredQuantity || 1);

        if (quantityDiff !== 0) return quantityDiff;

        return (
          Number(a.originalIndex || 0) -
          Number(b.originalIndex || 0)
        );
      })[0];

    // 다음 상위 조건이 있으면 다음 목표 표시
    if (nextCondition) {
      return {
        ...nextCondition,
        hasCompletedLowerTier: true,
      };
    }

    // 더 높은 조건이 없으면 현재 최고 조건 표시
    return {
      ...currentEligibleCondition,
      hasCompletedLowerTier: false,
    };
  }, [collectionAmountInfos, currentEligibleCondition]);

  async function fetchGwp() {
    const query = `
      query getGwp($handle: MetaobjectHandleInput!) {
        metaobject(handle: $handle) {
          id
          handle
          fields {
            key
            value
            reference {
              ... on Product {
                id
                title
              }

              ... on Collection {
                id
                title
                handle
              }
            }

            references(first: 20) {
              nodes {
                ... on Metaobject {
                  id
                  handle
                  fields {
                    key
                    value

                    reference {
                      ... on Product {
                        id
                        title
                      }

                      ... on Collection {
                        id
                        title
                        handle
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    try {
      const result = await shopify.query(query, {
        variables: {
          handle: {
            type: GWP_TYPE,
            handle: GWP_HANDLE,
          },
        },
      });

      if (result?.errors?.length) {
        throw new Error(
          result.errors.map((error) => error.message).join(" / ")
        );
      }

      const metaobject = result?.data?.metaobject;

      if (!metaobject) {
        setGwp(null);
        return;
      }

      setGwp(parseGwp(metaobject));
    } catch (error) {
      console.error("fetchGwp error", error);
      setGwp(null);
    } finally {
      setLoading(false);
    }
  }

  async function fetchProductCollections(ids) {
    setCollectionsLoading(true);

    const query = `
      query getProductCollections($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title

            collections(first: 50) {
              nodes {
                id
                handle
                title
              }
            }
          }
        }
      }
    `;

    try {
      const result = await shopify.query(query, {
        variables: {
          ids,
        },
      });

      if (result?.errors?.length) {
        throw new Error(
          result.errors.map((error) => error.message).join(" / ")
        );
      }

      setProductsWithCollections(
        result?.data?.nodes?.filter(Boolean) || []
      );
    } catch (error) {
      console.error("fetchProductCollections error", error);
      setProductsWithCollections([]);
    } finally {
      setCollectionsLoading(false);
    }
  }

  function parseGwp(metaobject) {
    const fields = getFieldsMap(metaobject.fields);

    const conditionNodes =
      metaobject.fields.find(
        (field) => field.key === "conditions"
      )?.references?.nodes || [];

    return {
      id: metaobject.id,
      handle: metaobject.handle,
      title: fields.title,
      startDatetime: fields.start_datetime,
      endDatetime: fields.end_datetime,
      conditionTypes: parseConditionTypes(fields.condition_type),
      conditions: conditionNodes.map(parseCondition),
    };
  }

  function parseCondition(metaobject) {
    const fields = getFieldsMap(metaobject.fields);

    return {
      id: metaobject.id,
      handle: metaobject.handle,
      conditionTitle: fields.condition_title,
      thresholdAmount: fields.threshold_amount,
      currencyCode: CURRENCY_CODE,
      collection: getReferenceByKey(
        metaobject.fields,
        "collection"
      ),
      collectionOnly: fields.collection_only === "true",
      collectionQuantity: fields.collection_quantity,
      giftProduct: getReferenceByKey(
        metaobject.fields,
        "gift_product"
      ),
    };
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

  function getFieldsMap(fields) {
    return fields.reduce((acc, field) => {
      acc[field.key] = field.value;
      return acc;
    }, {});
  }

  function getReferenceByKey(fields, key) {
    const field = fields.find((item) => item.key === key);

    return (
      field?.reference ||
      field?.references?.nodes?.[0] ||
      null
    );
  }

  function isWithinCampaignPeriod(startDatetime, endDatetime) {
    const now = new Date();

    if (startDatetime) {
      const start = new Date(startDatetime);
      if (now < start) return false;
    }

    if (endDatetime) {
      const end = new Date(endDatetime);
      if (now > end) return false;
    }

    return true;
  }

  function formatMoney(amount) {
    return `¥${Math.floor(amount).toLocaleString("ja-JP")}`;
  }

  if (loading || collectionsLoading) {
    return null;
  }

  if (!gwp) return null;

  if (
    !isWithinCampaignPeriod(
      gwp.startDatetime,
      gwp.endDatetime
    )
  ) {
    return null;
  }

  if (!collectionAmountInfos.length) return null;
  if (!activeProgressInfo) return null;

  return (
  <s-box
    background="base"
    borderRadius="base"
    borderWidth="base"
    padding="large"
  >
    {(() => {
      const info = activeProgressInfo;

      const progressValue =
        info.thresholdAmount > 0
          ? Math.min(
              (info.currentAmount / info.thresholdAmount) * 100,
              100
            )
          : 0;

      return (
        <s-stack direction="block" gap="small-200">
            {!info.isAmountMatched ? (
              <s-stack direction="inline" gap="small-100" alignItems="center">
                <s-icon type="info" />

                <s-text>
                  {info.collectionTitle}商品をあと{" "}
                  {formatMoney(info.remainingAmount)}
                  ご購入ください。
                </s-text>
              </s-stack>
            ) : !info.isQuantityMatched ? (
              <s-stack direction="inline" gap="small-100" alignItems="center">
                <s-icon type="info" />

                <s-text>
                  {info.collectionTitle}商品をあと{" "}
                  {info.remainingQuantity}
                  点追加してください。
                </s-text>
              </s-stack>
            ) : (
              <s-stack direction="inline" gap="small-100" alignItems="center">
                <s-icon type="success" />

                <s-text>
                  プレゼントの獲得条件を達成しました。
                </s-text>
              </s-stack>
            )}
          <s-stack
            direction="inline"
            justifyContent="space-between"
            alignItems="center"
          >
            <s-text emphasis="bold">
              現在 {formatMoney(info.currentAmount)}
            </s-text>

            <s-text color="subdued">
              目標 {formatMoney(info.thresholdAmount)}
            </s-text>
          </s-stack>

          <s-progress
            value={progressValue}
            max={100}
            accessibilityLabel={`${formatMoney(
              info.currentAmount
            )} of ${formatMoney(info.thresholdAmount)}`}
          />
        </s-stack>
      );
    })()}
  </s-box>
);
}