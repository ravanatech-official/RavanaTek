import React from 'react';

interface ServicesScreenProps {
  isActive: boolean;
  onNavigate: (screenId: string) => void;
  onSelectService: (serviceName: string) => void;
}

export const ServicesScreen: React.FC<ServicesScreenProps> = ({
  isActive,
  onNavigate,
  onSelectService,
}) => {
  const services = [
    {
      id: 'websites',
      title: 'Business Websites',
      icon: 'bx-globe',
      badge: 'TOP REQUEST',
      tag: 'HIGH SPEED',
      description: 'Clean, modern, high-speed websites for companies, shops, and professionals. Designed to build trust and turn visitors into paying clients.',
      specs: ['Fast Loading', 'Mobile Ready', 'Google Friendly'],
    },
    {
      id: 'ecommerce',
      title: 'Online Stores (E-Commerce)',
      icon: 'bx-shopping-bag',
      badge: 'HIGH DEMAND',
      tag: '24/7 SALES',
      description: 'Sell your products online 24/7. Simple product catalog, 1-click WhatsApp instant ordering, card payments, and fast mobile checkout.',
      specs: ['1-Click WhatsApp', 'Card Payments', 'Easy Management'],
    },
    {
      id: 'landing-pages',
      title: 'Fast Landing Pages',
      icon: 'bx-rocket',
      badge: 'HIGH CONVERSION',
      tag: 'AD CAMPAIGNS',
      description: 'Instant-loading single-page websites built for Facebook, TikTok & Google ad campaigns. Drives quick calls, messages, and quality leads.',
      specs: ['Instant Load', 'Lead Focused', 'Ad Ready'],
    },
  ];

  const handleBookService = (serviceTitle: string) => {
    onSelectService(serviceTitle);
    onNavigate('contact');
  };

  return (
    <section
      className={`systems section deck-screen ${isActive ? 'deck-screen-active' : ''}`}
      id="systems"
      data-screen-index="2"
      data-screen-id="systems"
      data-route="/systems"
      data-title="SERVICES // RAVANA TECH | Web Development Studio"
    >
      <div className="systems__container bd-grid">
        <div className="section-header">
          <span className="section-subtitle">MOST REQUESTED DIGITAL SOLUTIONS</span>
          <h2 className="section-title">WEB DEVELOPMENT SERVICES</h2>
        </div>

        <div className="systems__grid">
          {services.map((svc) => (
            <div key={svc.id} className="system-card hud-panel">
              <span className="hud-corner hud-corner-tl" />
              <span className="hud-corner hud-corner-tr" />
              <span className="hud-corner hud-corner-bl" />
              <span className="hud-corner hud-corner-br" />

              <div className="system-card__header">
                <div className="system-card__icon-wrap">
                  <i className={`bx ${svc.icon}`} />
                </div>
                <div className="system-card__meta">
                  <span className="system-card__badge">{svc.badge}</span>
                  <span className="system-card__tag">{svc.tag}</span>
                </div>
              </div>

              <h3 className="system-card__title">{svc.title}</h3>
              <p className="system-card__description">{svc.description}</p>

              <div className="system-card__specs">
                {svc.specs.map((spec, i) => (
                  <span key={i} className="spec-pill">
                    <i className="bx bx-check" /> {spec}
                  </span>
                ))}
              </div>

              <div className="system-card__footer">
                <button
                  type="button"
                  onClick={() => handleBookService(svc.title)}
                  className="button button-outline system-card__btn"
                >
                  <i className="bx bx-right-arrow-alt" />
                  GET QUOTE
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="services-more-wrap">
          <a href="/services.html" className="services-full-page-btn" title="View more web development services">
            <span className="launch-icon-ring"><i className="bx bx-layer" /></span>
            <div className="launch-text-wrap">
              <span className="launch-headline">VIEW MORE</span>
              <span className="launch-subline">EXPLORE ALL SERVICES</span>
            </div>
            <i className="bx bx-chevron-right launch-arrow" />
          </a>
        </div>
      </div>
    </section>
  );
};
