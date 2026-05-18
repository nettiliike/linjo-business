# Linjo Business

Linjo Business on yrityksille tarkoitettu AI-puhelinassistentti.

## Mitä tämä tekee?

- Vastaa Twilio-puheluihin
- Käyttää yrityksen omia tietoja vastauksissa
- Tallentaa puhelut Firebase Firestoreen
- Näyttää dashboardissa puhelut, riskit, yhteenvedot ja puheen sisällön
- Dashboardissa voi muokata:
  - yrityksen nimeä
  - verkkosivun osoitetta
  - aukioloaikoja
  - palveluita
  - usein kysyttyjä kysymyksiä
  - kolmea eri vastaustapaa

## Tärkeät URL:t

Renderissä:

- Etusivu: `/`
- Dashboard: `/dashboard`
- Twilio Voice webhook: `/voice`
- API puheluille: `/api/calls`
- API asetuksille: `/api/settings`
- API verkkosivun tietojen hakuun: `/api/scrape-website`

Twiliossa Voice webhook:

```txt
https://OMA-RENDER-OSOITE.onrender.com/voice
```

Method:

```txt
HTTP POST
```

## Render Environment Variables

Lisää Renderiin:

```txt
OPENAI_API_KEY
FIREBASE_SERVICE_ACCOUNT
ADMIN_PASSWORD
```

`FIREBASE_SERVICE_ACCOUNT` on koko Firebase service account JSON yhtenä rivinä.

## GitHubiin ei saa lisätä Firebase serviceAccountKey.json tiedostoa

Pidä salaiset avaimet vain Renderin Environment Variables -kohdassa.
