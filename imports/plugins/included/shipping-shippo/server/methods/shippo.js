/* eslint camelcase: 0 */
import _ from "lodash";
import { Meteor } from "meteor/meteor";
import { check, Match } from "meteor/check";
import { Roles } from "meteor/alanning:roles";
import { Reaction, Hooks } from "/server/api";
import { Packages, Accounts, Shops, Shipping, Cart, Orders } from "/lib/collections";
import { ShippoPackageConfig } from "../../lib/collections/schemas";
import { ShippoApi } from "./shippoapi";
import { shippingRoles } from "../lib/roles";

// Creates an address (for sender or recipient) suitable for Shippo Api Calls given
// a reaction address an email and a purpose("QUOTE"|"PURCHASE")
function createShippoAddress(reactionAddress, email, purpose) {
  const shippoAddress = {
    object_purpose: purpose,
    name: reactionAddress.fullName,
    street1: reactionAddress.address1,
    street2: reactionAddress.address2 || "", // "" in order to be cleaned later by SimpleSchema.clean
    city: reactionAddress.city,
    company: reactionAddress.company || "",
    state: reactionAddress.region,
    zip: reactionAddress.postal,
    country: reactionAddress.country,
    phone: reactionAddress.phone,
    email: email,
    is_residential: !reactionAddress.isCommercial
  };

  return shippoAddress;
}

// Creates a parcel object suitable for Shippo Api Calls given
// a reaction product's parcel and units of measure for mass and distance
function createShippoParcel(reactionParcel, cartWeight, reactionMassUnit, reactionDistanceUnit) {
  const shippoParcel = {
    width: reactionParcel.width || "",
    length: reactionParcel.length || "",
    height: reactionParcel.height || "",
    weight: cartWeight,
    distance_unit: reactionDistanceUnit,
    mass_unit: reactionMassUnit
  };

  return shippoParcel;
}

function getTotalCartweight(cart) {
  const totalWeight = cart.items.reduce((sum, cartItem) => {
    const itemWeight = cartItem.quantity * cartItem.parcel.weight;
    return sum + itemWeight;
  }, 0);
  return totalWeight;
}

// converts the Rates List fetched from the Shippo Api to Reaction Shipping Rates form
function ratesParser(shippoRates, shippoDocs) {
  return shippoRates.map(rate => {
    const rateAmount = parseFloat(rate.amount);
    // const methodLabel = `${rate.provider} - ${rate.servicelevel_name}`;
    const reactionRate = {
      carrier: rate.provider,
      method: {
        enabled: true,
        label: rate.servicelevel_name,
        rate: rateAmount,
        handling: 0,
        carrier: rate.provider,
        settings: {
          // carrierAccount: rate.carrier_account,
          rateId: rate.object_id,
          serviceLevelToken: rate.servicelevel_token
        }
      },
      rate: rateAmount,
      shopId: shippoDocs[rate.carrier_account].shopId
    };

    return reactionRate;
  });
}

// Filters the carrier list and gets and parses only the ones that are activated in the Shippo Account
function filterActiveCarriers(carrierList) {
  const activeCarriers = [];
  if (carrierList.results && carrierList.count) {
    carrierList.results.forEach(carrier => {
      if (carrier.active) {
        activeCarriers.push({
          carrier: carrier.carrier, // this is a property of the returned result with value the name of the carrier
          carrierAccountId: carrier.object_id
        });
      }
    });

    return activeCarriers;
  }
}

// usps_express to USPS EXPRESS .We need a better approach - use a suitable static map object
function formatCarrierLabel(carrierName) {
  return carrierName.replace(/_/g, " ").toUpperCase();
}

// get Shippo's Api Key from the Shippo package with the supplied shopId or alternatively of the current shop's Id
function getApiKey(shopId = Reaction.getShopId()) {
  const { settings } = Packages.findOne({
    name: "reaction-shippo",
    shopId
  });

  return settings.apiKey;
}

// Adds Shippo carriers in Shipping Collection (one doc per carrier) for the current Shop
function addShippoProviders(carriers, shopId = Reaction.getShopId()) {
  let result = true;
  carriers.forEach(carrier => {
    const carrierName = carrier.carrier;
    const carrierLabel = formatCarrierLabel(carrierName);
    const currentResult = Shipping.insert({
      name: `${carrierLabel}`, // check it later for a better name
      methods: [],
      provider: {
        name: carrierName,
        label: carrierLabel,
        enabled: true,
        shippoProvider: {
          carrierAccountId: carrier.carrierAccountId
        }
      },
      shopId
    });
    result = result && currentResult;
  });

  return result;
}

// Remove from Shipping Collection shop's Shippo Providers with carrier account Id in carriersIds
// or all of them (if carriersIds is set to false)
function removeShippoProviders(carriersIds, shopId = Reaction.getShopId()) {
  if (carriersIds) {
    return Shipping.remove({
      shopId,
      "provider.shippoProvider.carrierAccountId": { $in: carriersIds }
    });
  }

  return Shipping.remove({
    shopId,
    "provider.shippoProvider": { $exists: true }
  });
}

// After getting the current active Carriers of the Shippo Account removes
// from the Shipping Collection the Shippo providers that are deactivated(don't exist in active carriers)
// and inserts the newly active carriers in Shipping Collection as shippo providers.

function updateShippoProviders(activeCarriers, shopId = Reaction.getShopId()) {
  const currentShippoProviders = Shipping.find({
    "shopId": shopId,
    "provider.shippoProvider": { $exists: true }
  }, {
    fields: { "provider.shippoProvider.carrierAccountId": 1 }
  });

  // Ids of Shippo Carriers that exist currently as docs in Shipping Collection
  const currentCarriersIds = currentShippoProviders.map(doc => doc.provider.shippoProvider.carrierAccountId);

  const newActiveCarriers = [];
  const unchangedActiveCarriersIds = [];
  activeCarriers.forEach(carrier => {
    const carrierId = carrier.carrierAccountId;
    if (!currentCarriersIds.includes(carrierId)) {
      newActiveCarriers.push(carrier);
    } else {
      unchangedActiveCarriersIds.push(carrierId);
    }
  });

  const deactivatedCarriersIds = _.difference(currentCarriersIds, unchangedActiveCarriersIds);
  if (deactivatedCarriersIds.length) {
    removeShippoProviders(deactivatedCarriersIds, shopId);
  }
  if (newActiveCarriers.length) {
    addShippoProviders(newActiveCarriers, shopId);
  }

  return true;
}

export const methods = {
  /**
   * Updates the Api key(Live/Test Token) used for connection with the Shippo account.
   * Also inserts(and deletes if already exist) docs in the Shipping collection each of the
   * activated Carriers of the Shippo account.
   * This method is intended to be used mainly by Autoform.
   * @param {Object} modifier - The Autoform's modifier string
   * @param {String} _id - The id of the Shippo package that gets updated
   * @return {Object} result - The object returned.
   * @return {String} {string("update"|"delete")} result.type - The type of updating happened.
   */
  "shippo/updateApiKey"(modifier, _id) {
    // Important server-side check for security and data integrity
    check(modifier, ShippoPackageConfig);
    check(_id, String);

    // Make sure user has proper rights to this package
    const { shopId } = Packages.findOne({ _id },
      { field: { shopId: 1 } });
    if (shopId && Roles.userIsInRole(this.userId, shippingRoles, shopId)) {
      // If user wants to delete existing key
      if (modifier.hasOwnProperty("$unset")) {
        const customModifier = { $set: { "settings.apiKey": null } };
        Packages.update(_id, customModifier);
        // remove shop's existing Shippo Providers from Shipping Collection
        removeShippoProviders(false, shopId);

        return { type: "delete" };
      }

      const apiKey = modifier.$set["settings.apiKey"];

      // Tries to use the apiKey by fetching a list of the addresses of Shippo Account
      // if not possible throws a relative Meteor Error (eg invalid_credentials)
      ShippoApi.methods.getAddressList.call({ apiKey });
      // if everything is ok proceed with the api key update
      Packages.update(_id, modifier);
      // remove shop's existing Shippo Providers from Shipping Collection
      removeShippoProviders(false, shopId);

      const activeCarriers = filterActiveCarriers(ShippoApi.methods.getCarrierAccountsList.call({ apiKey }));
      if (activeCarriers.length) {
        addShippoProviders(activeCarriers, shopId);
      }

      return { type: "update" };
    }

    return false;
  },

  /**
   * Fetches the current active Shippo Carriers from the Shippo Account and updates the
   * Shipping Collection by keeping only these as Shippo Providers of the shop.
   * @return {Boolean} result - if the updating happened successfully or not.
   * */

  "shippo/fetchProviders"() {
    const shopId = Reaction.getShopId();

    if (Roles.userIsInRole(this.userId, shippingRoles, shopId)) {
      const apiKey = getApiKey(shopId);
      if (!apiKey) {
        return false;
      }

      const activeCarriers = filterActiveCarriers(ShippoApi.methods.getCarrierAccountsList.call({ apiKey }));
      return updateShippoProviders(activeCarriers, shopId);
    }

    return false;
  },

  /**
   * Fetches the tracking status of shipped orders from Shippo and updates the
   * relevant orders' properties
   * @param {String} orderId - optional orderId to get status of just one order.
   * @return {Boolean} result - if the updating happened successfully or not.
   * */
  "shippo/fetchTrackingStatusForOrders"(orderId) {
    check(orderId, Match.Optional(String));
    const shopId = Reaction.getShopId();
    let shippoOrders;
    const apiKey = getApiKey(shopId);
    if (!apiKey) {
      return false;
    }

    if (orderId) {
      // return a specific order
      shippoOrders = Orders.find({
        shopId,
        orderId
      });
    } else {
      // Find the orders of the shop that have shippo provider, tracking number, that are shipped
      // but they are not yet delivered;
      shippoOrders = Orders.find({
        shopId,
        "shipping.0.shippo.transactionId": { $exists: true },
        "shipping.0.tracking": { $exists: true },
        "shipping.0.shipped": true,
        "shipping.0.delivered": { $ne: true }
        // For now we don' t have logic for returned products
      });
    }


    // no orders to update
    if (!shippoOrders.count()) {
      return true;
    }

    // For each order get from Shippo the transaction item ,check the tracking and if it has been updated
    let updatingResult = true;
    shippoOrders.forEach(order => {
      const orderShipment = order.shipping[0];
      const transactionId = orderShipment.shippo.transactionId;
      const transaction = ShippoApi.methods.getTransaction.call({ apiKey, transactionId });

      // For Testing:
      // Comment First line of code, and uncomment following block to mock the updating of tracking status
      // as Shippo's tracking status for test Shipments isn't getting updated.
      const trackingStatus = transaction.tracking_status;
      // const trackingStatus = {};
      // if (transaction.object_state === "VALID") {
      //   trackingStatus.status_date = (new Date).toString();
      //   trackingStatus.status = (!orderShipment.shippo.trackingStatusStatus ? "TRANSIT" : "DELIVERED");
      // }

      if (trackingStatus &&
        trackingStatus.status_date !== orderShipment.shippo.trackingStatusDate) {
        // Shippo's tracking_status.status	enum	Indicates the high level status of the shipment:
        // 'UNKNOWN', 'DELIVERED', 'TRANSIT', 'FAILURE', 'RETURNED'.
        if (trackingStatus.status === "DELIVERED") {
          Meteor.call("orders/shipmentDelivered", order);
        }

        // A batch update might be better option. Unfortunately Reaction.import doesn't support
        // .. Orders currently
        const orderUpdating = Orders.update({
          _id: order._id
        }, {
          $set: {
            "shipping.0.shippo.trackingStatusDate": trackingStatus.status_date,
            "shipping.0.shippo.trackingStatusStatus": trackingStatus.status
          }
        });
        updatingResult = updatingResult && orderUpdating;
      }
    });

    return updatingResult;
  },

  /**
   * Returns the available Shippo Methods/Rates for a selected cart,
   * in the same form shipping/getShippingRates returns them.
   * @param {String} cartId - The id of the cart that rates are to be supplied.
   * @param {Object} shippoDocs - Contains all the enabled shipping objects with
   * provider.shippoProvider property. Each property has as key the Shippo's
   * carrierAccountId and as value the corresponding document of shipping
   * collection.
   * @param {Array} retrialTargets - An array with the details of which
   * methods for getting shipping methods failed in the most recent
   * query of Shippo's API.
   * @param {String} shopId - The shop that rates will genererated for
   * @return {Array} errorDetailsAndRetryInfo - Details of any error that
   * occurred while querying Shippo's API, and info about this package so
   * as to know if this specific query is to be retried.
   * @return {Array} rates - The rates of the enabled and available
   * Shippo carriers, and an empty array.
   */
  "shippo/getShippingRatesForCart"(cartId, shopId, shippoDocs, retrialTargets) {
    check(cartId, String);
    check(shopId, String);
    check(shippoDocs, Object);
    check(retrialTargets, Array);

    const currentMethodInfo = {
      packageName: "shippo",
      fileName: "shippo.js"
    };
    const errorDetails = {
      requestStatus: "error",
      shippingProvider: "shippo"
    };

    let isRetry;
    if (retrialTargets.length > 0) {
      const isNotAmongFailedRequests = retrialTargets.every((target) =>
        target.packageName !== currentMethodInfo.packageName &&
        target.fileName !== currentMethodInfo.fileName
      );
      if (isNotAmongFailedRequests) {
        return [[], retrialTargets];
      }

      isRetry = true;
    }


    const cart = Cart.findOne(cartId);
    if (cart && cart.userId === this.userId) { // confirm user has the right
      if (!cart.items || !cart.items.length) {
        errorDetails.message = "This cart has no items";
        return [[errorDetails], []];
      }

      const shopItems = cart.items.filter( item => item.shopId === shopId);

      if (!shopItems.length) {
        errorDetails.message = `This cart has no items of shop ${shopId}.`;
        return [[errorDetails], []];
      }

      // Todo: This approach is a little bit naive, as it searches for the biggest-volumed parcel of the items
      // and use this for all the items. A better approach could be to have a list of the available default
      // parcel-boxes of each seller and create a logic to put items in the least possible parcels.
      const biggestAvailableParcel =  shopItems.reduce((prev, current) => {
        const parcel = current.parcel;
        if (!parcel) {
          return prev;
        }
        const volume = (parcel.width * parcel.height * parcel.length);
        return (prev.volume > volume) ? prev : Object.assign({}, parcel, {volume});
      },{ volume:0 });

      if (biggestAvailableParcel.volume  === 0) {
        errorDetails.message = `This cart has not a parcel for items of shop ${shopId}.`;
        return [[errorDetails], []];
      }
      delete biggestAvailableParcel.volume;

      let shippoAddressTo;
      let shippoParcel;
      const purpose = "PURCHASE";

      const shop = Shops.findOne({
        _id: shopId
      }, {
        field: {
          addressBook: 1,
          emails: 1,
          unitsOfMeasure: { $elemMatch: { default: true } }
        }
      });

      const apiKey = getApiKey(cart.shopId);
      // If for a weird reason Shop hasn't a Shippo Api key anymore return no-rates.
      if (!apiKey) {
        // In this case, and some similar ones below, there's no need
        // for a retry.
        errorDetails.message = "No Shippo API key was found for this cart.";
        return [[errorDetails], []];
      }
      // TODO create a shipping address book record for shop.
      const shippoAddressFrom = createShippoAddress(shop.addressBook[0], shop.emails[0].address, purpose);
      // product in the cart has to have parcel property with the dimensions
      const unitOfMeasure = shop && shop.baseUOM || "kg";
      const unitOfLength = shop && shop.baseUOL || "cm";
      const cartWeight = getTotalCartweight(cart);
      shippoParcel = createShippoParcel(biggestAvailableParcel, cartWeight, unitOfMeasure, unitOfLength);

      const buyer = Accounts.findOne({
        _id: this.userId
      }, {
        field: { emails: 1 }
      });
      // check that there is address available in cart
      if (cart.shipping && cart.shipping[0] && cart.shipping[0].address) {
        // TODO take a more elegant approach to guest checkout -> no email address
        // add Logger.trace if this smells
        let email = shop.emails[0].address || "noreply@localhost";
        if (buyer.emails.length > 0) {
          if (buyer.emails[0].address) {
            email = buyer.emails[0].address;
          }
        }
        shippoAddressTo = createShippoAddress(cart.shipping[0].address, email, purpose);
      } else {
        errorDetails.message = "The 'shipping' property of this cart is either missing or incomplete.";
        return [[errorDetails], []];
      }
      const carrierAccounts = Object.keys(shippoDocs);
      let shippoShipment;
      try {
        shippoShipment = ShippoApi.methods.createShipment.call({
          shippoAddressFrom,
          shippoAddressTo,
          shippoParcel,
          purpose,
          carrierAccounts,
          apiKey
        });
      } catch (error) {
        const errorData = {
          requestStatus: "error",
          shippingProvider: "shippo",
          message: error.message
        };

        if (isRetry) {
          errorDetails.message = "The Shippo API call has failed again.";
          return [[errorDetails], []];
        }

        return [[errorData], [currentMethodInfo]];
      }

      if (!shippoShipment.rates_list || shippoShipment.rates_list.length === 0) {
        const noShippingMethods = {
          requestStatus: "error",
          shippingProvider: "shippo",
          message: "Couldn't find any shipping methods. Try using another address."
        };

        if (isRetry) {
          errorDetails.message = "Didn't get any shipping methods. The Shippo API call has failed again.";
          return [[errorDetails], []];
        }

        return [[noShippingMethods], [currentMethodInfo]];
      }

      const shippoRates = shippoShipment.rates_list;
      const reactionRates = ratesParser(shippoRates, shippoDocs);

      return [reactionRates, []];
    }

    errorDetails.message = "Error. Your cart is either undefined or has the wrong userId.";
    return [[errorDetails], []];
  },

  /**
   * Confirms Shippo order based on buyer's choice at the time of purchase
   * and supplies the order doc with the tracking and label infos
   * @param {String} orderId - The id of the ordered that labels are purchased for
   * @param {String} shopId - the id of the shop confirming the shippingMethod
   * @return {Boolean} result - True if procedure completed succesfully,otherwise false
   * @todo As the goal is multiple shipments ,from the same shop, to be able to exist in an
   * order(e.g Seller sends item1 with
   * dhl-standard , item2 with dhl-prority an extra parameter could exist: shippingId
   */
  "shippo/confirmShippingMethodForOrder"(orderId, shopId) {
    check(orderId, String);
    check(shopId, String);
    const order = Orders.findOne(orderId);

    if (!Reaction.hasPermission(shippingRoles, this.userId, shopId)) {
      throw new Meteor.Error("access-denied", "Access Denied");
    }
    const shipping = order.shipping.find(shippingRec => (
      shippingRec.shopId === shopId &&
      shippingRec.shipmentMethod.settings &&
      shippingRec.shipmentMethod.settings.rateId
    ));
    if (!shipping) {
      throw new Meteor.Error("not-found", "Not found valid shipping method");
    }

    const apiKey = getApiKey(order.shopId);
    if (!apiKey) {
      throw new Meteor.Error("invalid-credentials", "Invalid Credentials");
    }

    const rateId = shipping.shipmentMethod.settings.rateId;
    // make the actual purchase
    const transaction = ShippoApi.methods.createTransaction.call({ rateId, apiKey });
    if (transaction) {
      return Orders.update({
        _id: orderId
      }, {
        $set: {
          "shipping.0.shippingLabelUrl": transaction.label_url,
          "shipping.0.tracking": transaction.tracking_number,
          "shipping.0.shippo.transactionId": transaction.object_id,
          "shipping.0.shippo.trackingStatusDate": null,
          "shipping.0.shippo.trackingStatusStatus": null
        }
      });
    }

    return false;
  }
};

Meteor.methods(methods);

Hooks.Events.add("onOrderPaymentCaptured", methods["shippo/confirmShippingMethodForOrder"]);
