import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  useCartLines,
  useTotalAmount,
  useInstructions,
} from "@shopify/ui-extensions/checkout/preact";

export default function extension() {
  render(<DebugExtension />, document.body);
}

const GWP_HANDLE = "app--379210334209--gwp-usymljaq";
const GWP_TYPE = "app--379210334209--gwp";
const TEST_TAG = "gwp-test";

function DebugExtension() {
  const cartLines = useCartLines();
  const total = useTotalAmount();
  const instructions = useInstructions();

  const [isTestCustomer, setIsTestCustomer] = useState(false);
  const [tagLoading, setTagLoading] = useState(true);
  const [gwp, setGwp] = useState(null);
  const [loading, setLoading] = useState(true);

  const totalAmount = Number(total?.amount ?? 0);

  useEffect(() => {
    checkCustomerTag();
    fetchGwp();
  }, []);

  async function checkCustomerTag() {
    const query = `
      query {
        customer {
          hasTags(tags: ["${TEST_TAG}"]) {
            tag
            hasTag
          }
        }
      }
    `;

    try {
      const result = await shopify.query(query);
      const hasTag = result?.data?.customer?.hasTags?.some(
        (item) => item.tag === TEST_TAG && item.hasTag === true
      );

      setIsTestCustomer(Boolean(hasTag));
    } catch (error) {
      setIsTestCustomer(false);
    } finally {
      setTagLoading(false);
    }
  }

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
          handle: { type: GWP_TYPE, handle: GWP_HANDLE },
        },
      });

      const metaobject = result?.data?.metaobject;
      setGwp(metaobject ? parseGwp(metaobject) : null);
    } catch (error) {
      setGwp(null);
    } finally {
      setLoading(false);
    }
  }

  function parseGwp(metaobject) {
    const fields = getFieldsMap(metaobject.fields);
    const conditionNodes =
      metaobject.fields.find((f) => f.key === "conditions")?.references?.nodes || [];

    return {
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
      collectionOnly: fields.collection_only,
      collectionQuantity: fields.collection_quantity,
      productQuantity: fields.product_quantity,
      giftProduct: getReferenceByKey(metaobject.fields, "gift_product"),
      collection: getReferenceByKey(metaobject.fields, "collection"),
      product: getReferenceByKey(metaobject.fields, "product"),
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
    const field = fields.find((f) => f.key === key);
    return field?.reference || null;
  }

  const conditionTypes = gwp?.conditionTypes || [];
  const conditions = gwp?.conditions || [];

  const giftProductIds = useMemo(() => {
    return conditions
      .map((condition) => condition.giftProduct?.id)
      .filter(Boolean);
  }, [conditions]);

  const hasAmountCondition = conditionTypes.includes("amount");

  const isBelowAllAmountThresholds =
    hasAmountCondition &&
    conditions.length > 0 &&
    conditions.every(
      (condition) =>
        totalAmount < Number(condition.thresholdAmount || 0)
    );

  const giftLines = cartLines.filter((line) =>
    giftProductIds.includes(line?.merchandise?.product?.id)
  );

  const cartProductIds = cartLines.map((line) => ({
    productId: line?.merchandise?.product?.id,
    quantity: line?.quantity,
    amount: line?.cost?.totalAmount?.amount,
  }));

  if (tagLoading || loading) return null;

  // if (!isTestCustomer) return null;
  if (totalAmount < 175000) return null;

  const shouldRemoveByAmount =
  isBelowAllAmountThresholds && giftLines.length > 0;

  const removeBlockedReason =
    shouldRemoveByAmount && !instructions?.lines?.canRemoveCartLine
      ? "canRemoveCartLine = false"
      : "none";

  return (
    <s-box background="subdued" borderRadius="base" borderWidth="base" padding="base">
      <s-stack gap="small-100">
        <s-text size="medium" emphasis="bold">
          GWP Debug Box
        </s-text>

        <s-text>extensionVersion: 2026-06-11-01</s-text>
        <s-text>totalAmount: {String(totalAmount)}</s-text>
        <s-text>conditionTypes: {JSON.stringify(conditionTypes)}</s-text>
        <s-text>hasAmountCondition: {String(hasAmountCondition)}</s-text>
        <s-text>
          thresholds: {JSON.stringify(conditions.map((c) => c.thresholdAmount))}
        </s-text>
        <s-text>
          isBelowAllAmountThresholds: {String(isBelowAllAmountThresholds)}
        </s-text>
        <s-text>giftProductIds: {JSON.stringify(giftProductIds)}</s-text>
        <s-text>giftLinesCount: {String(giftLines.length)}</s-text>
        <s-text>
          canRemoveCartLine: {String(instructions?.lines?.canRemoveCartLine)}
        </s-text>
        <s-text>
          cartProductIds: {JSON.stringify(cartProductIds)}
        </s-text>
        <s-text>shouldRemoveByAmount: {String(shouldRemoveByAmount)}</s-text>
        <s-text>removeBlockedReason: {removeBlockedReason}</s-text>
      </s-stack>
    </s-box>
  );
}